import { z } from 'zod';
import { sanitizeForTerminal } from './output';
import type { ScanFinding } from './scan';

/**
 * The server-side ingest scan gate as the CLI sees it; the consent half is
 * `throughScanGate` in lib/consent.ts, the server sibling is tenjin#723. The
 * gate runs the same rule corpus in the
 * marketplace's write path, so a publisher not running this CLI is gated too;
 * this module is the client half of that protocol.
 *
 * Two rejection codes, both 422, both carrying `error.details.scan`:
 *   - `scan_blocked`   — a block-tier finding. There is NO acknowledgement path.
 *   - `scan_needs_ack` — warn findings plus an `ackToken` bound to the content
 *                        hash and the finding set. Resending the SAME content
 *                        with the token publishes.
 * In the server's default advisory mode nothing is rejected and the same report
 * rides the SUCCESS response instead, which older clients simply ignore.
 *
 * Version skew is the design constraint here, so nothing in this file knows a
 * detector name. Findings are DATA (detector id, tier, redacted excerpt, offset)
 * and are parsed leniently: a detector, a tier, or a `checks` key this release
 * has never heard of renders faithfully rather than being dropped, and the
 * server stays authoritative about what its own codes mean.
 */

/** The two gate rejection codes, as `error.code` carries them. */
export const SCAN_BLOCKED = 'scan_blocked';
export const SCAN_NEEDS_ACK = 'scan_needs_ack';

/**
 * A finding as the gate sends it. `severity` and `field` are open strings: a
 * newer server may grow a tier or a submitted field this release predates, and
 * refusing to render it would hide exactly the finding the operator most needs
 * to see. Which tier a finding belongs to is never inferred from this value —
 * the ERROR CODE decides that, and the server owns it.
 */
export const serverScanFindingSchema = z
  .object({
    check: z.string(),
    severity: z.string(),
    line: z.number(),
    span: z.tuple([z.number(), z.number()]).optional(),
    excerpt: z.string(),
    field: z.string().optional(),
  })
  .loose();

export type ServerScanFinding = z.infer<typeof serverScanFindingSchema>;

/**
 * The report body. Malformed entries are DROPPED rather than failing the parse:
 * a rejection whose envelope we could not read must still stop the publish, and
 * one unreadable finding must not cost the operator the readable ones.
 */
export const serverScanReportSchema = z
  .object({
    findings: z.array(z.unknown()).optional(),
    checks: z.object({ semantic: z.string().optional() }).loose().optional(),
    ackToken: z.string().optional(),
    acked: z.boolean().optional(),
  })
  .loose();

export interface ServerScanReport {
  findings: ServerScanFinding[];
  /** `ran` | `skipped` today. Open: the unattended lane behind
   *  `PublishDeps.ackServerWarnings` (commands/publish.ts) reads it fail-closed. */
  semantic?: string;
  ackToken?: string;
  acked?: boolean;
}

/** A parsed gate rejection. `blocked` has no `ackToken` and never will. */
export interface ScanGateRejection {
  kind: 'blocked' | 'needs-ack';
  /** The server's own message, echoed rather than reworded. */
  message: string;
  report: ServerScanReport;
}

function toReport(raw: unknown): ServerScanReport {
  const parsed = serverScanReportSchema.safeParse(raw);
  if (!parsed.success) return { findings: [] };
  const findings: ServerScanFinding[] = [];
  for (const entry of parsed.data.findings ?? []) {
    const finding = serverScanFindingSchema.safeParse(entry);
    if (finding.success) findings.push(finding.data);
  }
  const semantic = parsed.data.checks?.semantic;
  return {
    findings,
    ...(semantic !== undefined ? { semantic } : {}),
    ...(parsed.data.ackToken !== undefined ? { ackToken: parsed.data.ackToken } : {}),
    ...(parsed.data.acked !== undefined ? { acked: parsed.data.acked } : {}),
  };
}

function errorNode(json: unknown): { code?: unknown; message?: unknown; details?: unknown } | null {
  if (typeof json !== 'object' || json === null) return null;
  const err = (json as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return null;
  return err as { code?: unknown; message?: unknown; details?: unknown };
}

function scanNode(details: unknown): unknown {
  if (typeof details !== 'object' || details === null) return undefined;
  return (details as { scan?: unknown }).scan;
}

/**
 * A gate rejection out of an error response, or null when this is some other
 * failure. Status is checked alongside the code so a 500 that happens to echo a
 * gate-shaped body is not read as one.
 *
 * A rejection with an unreadable `details.scan` still parses — as a rejection
 * with zero findings. The alternative (falling through to the generic failure
 * path) would turn "the server refused this content" into "the publish failed
 * for an unknown reason", which is strictly less true.
 */
export function parseScanRejection(status: number, json: unknown): ScanGateRejection | null {
  if (status !== 422) return null;
  const err = errorNode(json);
  if (err === null || typeof err.code !== 'string') return null;
  if (err.code !== SCAN_BLOCKED && err.code !== SCAN_NEEDS_ACK) return null;
  const report = toReport(scanNode(err.details));
  return {
    kind: err.code === SCAN_BLOCKED ? 'blocked' : 'needs-ack',
    message: typeof err.message === 'string' ? err.message : `Publish refused (${err.code}).`,
    // A token on a `blocked` envelope would be a bug server-side; drop it here so
    // no client path can ever ack a block.
    report: err.code === SCAN_BLOCKED ? { ...report, ackToken: undefined } : report,
  };
}

/**
 * The advisory report riding a SUCCESS response's `scan` field, or null when
 * the server sent none (every server before the gate shipped, and every write
 * the gate does not cover). Informational only: it never blocks, and it never
 * turns a 200 into a failure.
 */
export function parseScanSuccessReport(json: unknown): ServerScanReport | null {
  if (typeof json !== 'object' || json === null) return null;
  const raw = (json as { scan?: unknown }).scan;
  if (raw === undefined || raw === null) return null;
  const report = toReport(raw);
  if (report.findings.length === 0 && report.semantic === undefined) return null;
  return report;
}

// ---------------------------------------------------------------------------
// Merge + projection.
// ---------------------------------------------------------------------------

/** Where a rendered finding came from; `both` means the two scans agreed. */
export type FindingSource = 'local' | 'server' | 'both';

/** One finding as the consent payload and the human renderer carry it. */
export interface RenderedFinding {
  check: string;
  severity: string;
  line: number;
  excerpt: string;
  source: FindingSource;
  /** Which submitted field the server matched in; absent for local findings. */
  field?: string;
}

function offsetKey(check: string, line: number, span: readonly number[] | undefined): string {
  return `${check}@${line}:${span?.[0] ?? '-'}:${span?.[1] ?? '-'}`;
}

function valueKey(check: string, excerpt: string): string {
  // NUL separates the two halves: it cannot occur in a detector id, and a
  // server excerpt carrying one is already the hostile case this key guards.
  return `${check}\u0000${excerpt}`;
}

/**
 * One server finding's MATCH SITE: detector, coordinates, submitted field, and
 * excerpt. Two server entries collapse only when every one of those agrees, i.e.
 * when the server sent the same finding twice. Anything less is two match sites,
 * and an excerpt is redacted, so it cannot tell one value reported at two sites
 * from two different values that redact to the same string.
 */
function serverSiteKey(f: ServerScanFinding): string {
  return `${offsetKey(f.check, f.line, f.span)}\u0000${f.field ?? '-'}\u0000${f.excerpt}`;
}

/**
 * Merge the local scan's warn findings with the server's, deduped so the same
 * finding renders ONCE. Local entries come first and win the rendering: their
 * offsets point into the operator's own file, while the server's are relative to
 * the submitted field.
 *
 * THE ONE DIRECTION THIS MERGE MUST NOT ERR IN is collapsing two findings into
 * one rendered line, because the ack token covers the server's whole set while
 * the operator only ever answers what was rendered. Splitting costs a duplicate
 * line; collapsing costs material acked unseen. So two entries collapse only
 * where collapsing is provably right, and the two sides have different proofs.
 *
 * ACROSS THE SIDES, by value. The local scan reads the whole file (frontmatter
 * included) while the gate scans the extracted body, so one secret lands on
 * different line numbers and offsets cannot match it up; detector + excerpt can,
 * and a local excerpt the operator can see in their own file is what makes that
 * safe. `byOffset` and `byValue` are LOCAL-side keys, never written by the
 * server loop: reading `byOffset` there collapsed a distinct server finding into
 * a local one whose per-field coordinates merely coincided.
 *
 * WITHIN THE SERVER'S OWN SET, by match site (detector, coordinates, field,
 * excerpt) and not by value. A server excerpt is redacted and can be a fixed
 * string, so two entries sharing one cannot be told apart: one value reported at
 * two sites and two values that redact alike look identical from here. Value
 * alone therefore dropped the second of two distinct same-detector secrets, and
 * a same-length pair or a fixed semantic excerpt is enough to trigger it. The
 * site key keeps both and collapses only a finding the server sent twice. The
 * cost is that one secret genuinely occurring in two fields renders twice, on
 * two different lines, which is what actually happened.
 */
export function mergeScanFindings(
  local: ScanFinding[],
  server: ServerScanFinding[],
): RenderedFinding[] {
  const out: RenderedFinding[] = [];
  const byOffset = new Map<string, RenderedFinding>();
  const byValue = new Map<string, RenderedFinding>();

  for (const f of local) {
    const oKey = offsetKey(f.check, f.line, f.span);
    const vKey = valueKey(f.check, f.excerpt);
    if (byOffset.has(oKey) || byValue.has(vKey)) continue;
    const rendered: RenderedFinding = {
      check: f.check,
      severity: f.severity,
      line: f.line,
      excerpt: f.excerpt,
      source: 'local',
    };
    byOffset.set(oKey, rendered);
    byValue.set(vKey, rendered);
    out.push(rendered);
  }

  const sites = new Set<string>();
  for (const f of server) {
    const site = serverSiteKey(f);
    if (sites.has(site)) continue;
    sites.add(site);
    // The cross-side match, and the ONLY read of a local-side key here. A hit
    // means the operator can see this value in their own file, which is what
    // makes collapsing it safe; `byValue` is deliberately not written back, so
    // one server entry never absorbs another.
    const agreed = byValue.get(valueKey(f.check, f.excerpt));
    if (agreed !== undefined) {
      agreed.source = 'both';
      continue;
    }
    out.push({
      check: f.check,
      severity: f.severity,
      line: f.line,
      excerpt: f.excerpt,
      source: 'server',
      ...(f.field !== undefined ? { field: f.field } : {}),
    });
  }
  return out;
}

/**
 * The gate's report on a write that SUCCEEDED, as machine data. `acked` records
 * that this run answered a warn-tier hold rather than sailing past one, and
 * `semantic` is the check marker the unattended lane behind
 * `PublishDeps.ackServerWarnings` (commands/publish.ts) reads fail-closed.
 * Findings stay the server's own renderable data, so a detector
 * this release has never heard of arrives intact.
 */
export function scanReceipt(report: ServerScanReport): {
  findings: RenderedFinding[];
  semantic?: string;
  acked?: boolean;
} {
  return {
    findings: mergeScanFindings([], report.findings),
    ...(report.semantic !== undefined ? { semantic: report.semantic } : {}),
    ...(report.acked !== undefined ? { acked: report.acked } : {}),
  };
}

/**
 * The same report as human lines — the server's warn tier while it is still in
 * advisory mode measuring its false-positive rate, or the findings this run
 * acknowledged. Informational: they never block, and they are never silent
 * either, since the point of an advisory tier is that somebody reads it.
 *
 * Sanitized here because a finding excerpt is content, and an excerpt of a
 * detector this release predates has had no other pass over it.
 */
export function scanNoteLines(report: ServerScanReport | undefined): string[] {
  if (report === undefined || report.findings.length === 0) return [];
  const lead =
    report.acked === true
      ? 'Acknowledged marketplace scan findings:'
      : 'Marketplace scan findings (advisory, nothing was blocked):';
  return [
    lead,
    ...report.findings.map(
      (f) =>
        `  ${sanitizeForTerminal(f.check)} (${sanitizeForTerminal(f.severity)}, line ${f.line}): ${sanitizeForTerminal(f.excerpt)}`,
    ),
  ];
}

/** "N finding(s) (check, check)" — the shared half of every gate message. */
export function describeRendered(findings: RenderedFinding[]): string {
  const checks = [...new Set(findings.map((f) => f.check))].join(', ');
  return checks.length > 0
    ? `${findings.length} finding(s) (${checks})`
    : `${findings.length} finding(s)`;
}
