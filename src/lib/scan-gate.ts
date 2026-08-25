import { z } from 'zod';
import { sanitizeForTerminal } from './output';
import type { ScanFinding } from './scan';

/**
 * The server-side ingest scan gate as the CLI sees it (session-observer plan,
 * PR 2b; server sibling tenjin#723). The gate runs the same rule corpus in the
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
  /** `ran` | `skipped` today. Open: the observer lane (PR 5) reads it fail-closed. */
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
 * Merge the local scan's warn findings with the server's, deduped so the same
 * finding renders ONCE. Local entries come first and win the rendering: their
 * offsets point into the operator's own file, while the server's are relative to
 * the submitted field.
 *
 * Two keys, and a match on EITHER collapses. Offset alone is not enough — the
 * local scan reads the whole file (frontmatter included) while the gate scans
 * the extracted body, so the identical secret lands on different line numbers —
 * and value alone is not enough either, since a redaction can differ across
 * corpus versions. Erring toward collapsing is safe (the finding is still
 * rendered, once); erring toward splitting shows the operator the same secret
 * twice and teaches them to skim.
 *
 * The offset key is a LOCAL-side key only, and that is the whole reason server
 * findings are keyed by value alone. Offsets are per-field: the server reports
 * `line`/`span` relative to the submitted field it matched in, so two findings
 * from DIFFERENT fields sharing a detector, a line and a span are a coordinate
 * coincidence rather than one finding, and two different secrets in a one-line
 * `title` and a one-line `excerpt` collide constantly. Collapsing those would
 * drop material the operator then acks without ever seeing, which is the one
 * direction this merge must not err in.
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

  for (const f of server) {
    const oKey = offsetKey(f.check, f.line, f.span);
    const vKey = valueKey(f.check, f.excerpt);
    const seen = byOffset.get(oKey) ?? byValue.get(vKey);
    if (seen !== undefined) {
      if (seen.source === 'local') seen.source = 'both';
      continue;
    }
    const rendered: RenderedFinding = {
      check: f.check,
      severity: f.severity,
      line: f.line,
      excerpt: f.excerpt,
      source: 'server',
      ...(f.field !== undefined ? { field: f.field } : {}),
    };
    byValue.set(vKey, rendered);
    out.push(rendered);
  }
  return out;
}

/**
 * The gate's report on a write that SUCCEEDED, as machine data. `acked` records
 * that this run answered a warn-tier hold rather than sailing past one, and
 * `semantic` is the check marker the unattended observer lane (PR 5) reads
 * fail-closed. Findings stay the server's own renderable data, so a detector
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
