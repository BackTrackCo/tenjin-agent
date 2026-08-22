import { createSessionKeyAuth, createSiwxAuth, SESSION_CHAIN_ID } from './session-key';
import type { SessionScope, WriteAuth } from './session-key';
import type { PublishMode } from './config';
import { PublishModeSchema } from './config';
import { CliError } from './errors';
import { ScanGateError } from './posts-api';
import { describeRendered, mergeScanFindings } from './scan-gate';
import type { ResolvedPublishSettings } from './settings';
import type { ScanFinding } from './scan';
import type { TenjinSigner } from './wallet';

/**
 * The consent layer both writing commands share (`publish` and `edit`): the write
 * auth they sign through, the publish.mode gate, the stderr mode notices, and the
 * scan-finding shaping their refusal payloads carry. It lives here because the two
 * commands must gate IDENTICALLY — an edit ships content to the same public page a
 * publish does — and a second copy of a gate is a gate that drifts.
 */

/**
 * Writes require Base mainnet per the server's SIWX chain constraint. Aliased to
 * the one session chain id rather than re-declared: `tenjin session start` mints
 * into the same `session.json` this path reuses, and two constants that drifted
 * would silently invalidate each other's cached delegation.
 */
export const WRITE_CHAIN_ID = SESSION_CHAIN_ID;

export interface WriteAuthOptions {
  signer: TenjinSigner;
  baseUrl: string;
  dataDir: string;
  /**
   * Least privilege for what this run will do: 'read' for an owner-scoped read,
   * 'read+write' for anything that writes. A cached wider session still satisfies
   * a narrower need, so asking for 'read' costs no extra wallet signature.
   */
  scope: SessionScope;
  /** Force the plain-SIWX path (default: session key unless TENJIN_NO_SESSION=1). */
  useSession?: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * The write-auth seam: a session key by default (one wallet signature per session,
 * then P-256 signatures per request), the plain-SIWX fallback when sessions are
 * disabled.
 */
export function resolveWriteAuth(opts: WriteAuthOptions): WriteAuth {
  const config = {
    signer: opts.signer,
    baseUrl: opts.baseUrl,
    chainId: WRITE_CHAIN_ID,
    dataDir: opts.dataDir,
    scope: opts.scope,
  };
  const useSession = opts.useSession ?? opts.env.TENJIN_NO_SESSION !== '1';
  return useSession ? createSessionKeyAuth(config) : createSiwxAuth(config);
}

/**
 * The consent gate (D38): review always asks; auto asks only on a soft finding;
 * full-auto proceeds past soft findings. A hard block is NOT here — it refuses in
 * every mode and is never reachable by consent.
 */
export function needsConfirmation(mode: PublishMode, warnCount: number): boolean {
  return mode === 'review' || (mode === 'auto' && warnCount > 0);
}

/**
 * Whether this run may acknowledge the SERVER gate's warn findings on the
 * operator's behalf, mirroring {@link needsConfirmation} exactly: `review` and
 * `auto` stop on a server warn the same way they stop on a local one, and only
 * `full-auto` — or an explicit `--yes`, which is the operator's own yes against
 * the findings the previous run rendered — re-runs carrying the token.
 *
 * `override` exists for a caller whose answer is never yes whatever the mode:
 * the session observer (PR 5) publishes unattended, so a server warn must drop
 * its candidate to draft rather than be acked by a config value. Keeping that a
 * parameter rather than a second mode is what stops the observer's rule from
 * being re-derived from `publish.mode`, which it is deliberately orthogonal to.
 */
export function acksServerWarnings(mode: PublishMode, yes: boolean, override?: boolean): boolean {
  if (override !== undefined) return override;
  return yes || mode === 'full-auto';
}

export interface ScanGateFlow<T> {
  /** Perform the write; called a second time with the ack token on an approved yes. */
  send: (scanAck?: string) => Promise<T>;
  /** This run's local scan warns, so the server's merge in rather than repeat. */
  localWarns: ScanFinding[];
  mode: PublishMode;
  yes: boolean;
  /** See {@link acksServerWarnings}; forces the answer whatever the mode says. */
  ackOverride?: boolean;
  /** Machine detail merged into the refusal payload beside `findings`. */
  detail: Record<string, unknown>;
  /** What the refusal calls this operation, e.g. "Publish" or "Edit". */
  noun: string;
  /** Appended to the held message, e.g. ", price $0.10". */
  heldSuffix?: string;
}

/**
 * The server ingest gate's half of the consent flow (session-observer plan PR
 * 2b), shared by `publish` and `edit` for the same reason the rest of this file
 * is: an edit ships content to the same public page a publish does, and a second
 * copy of a gate is a gate that drifts.
 *
 * A `scan_blocked` is terminal in every mode — there is no acknowledgement path
 * server-side, so there is none here. A `scan_needs_ack` merges the server's
 * findings with the local scan's, renders them ONCE through the same exit-3
 * payload a local warn already uses, and re-runs the identical content carrying
 * the token when {@link acksServerWarnings} says yes.
 *
 * Exactly one ack retry. The token is bound to this content and this finding
 * set, so a second `needs_ack` is the server answering a question we did not
 * ask; looping on it would re-sign and resend the same body indefinitely.
 */
export async function throughScanGate<T>(flow: ScanGateFlow<T>): Promise<T> {
  try {
    return await flow.send();
  } catch (err) {
    if (!(err instanceof ScanGateError)) throw err;
    const findings = mergeScanFindings(flow.localWarns, err.rejection.report.findings);
    const semantic = err.rejection.report.semantic;
    const details = {
      ...flow.detail,
      findings,
      scan: { source: 'server', ...(semantic !== undefined ? { semantic } : {}) },
    };
    if (err.rejection.kind === 'blocked') {
      throw new CliError(
        'PUBLISH_BLOCKED',
        `${flow.noun} blocked by the marketplace scan: ${describeRendered(findings)}.`,
        {
          fix: 'Remove the flagged material from the content (the block tier has no acknowledgement path), then re-run.',
          details,
        },
      );
    }
    const token = err.rejection.report.ackToken;
    if (token === undefined || !acksServerWarnings(flow.mode, flow.yes, flow.ackOverride)) {
      throw new CliError(
        'NEEDS_CONFIRMATION',
        `${flow.noun} held by the marketplace scan: ${describeRendered(findings)}${flow.heldSuffix ?? ''}.`,
        {
          fix:
            token === undefined
              ? 'Resolve the findings in the content, then re-run.'
              : 'Review the findings, then re-run with --yes to proceed anyway (or resolve them in the content).',
          details,
        },
      );
    }
    return await flow.send(token);
  }
}

/**
 * The stderr notices that accompany a resolved mode: the resolver's own downgrade
 * warnings, a mistyped TENJIN_PUBLISH_MODE (which the resolver otherwise discards
 * silently), and a one-line explainer when the mode was never configured, so an
 * unconfigured write is never a silent surprise. `defaultExplainer` is the
 * command's own phrasing of what the default does.
 */
export function writeModeNotices(
  stderr: NodeJS.WritableStream,
  settings: ResolvedPublishSettings,
  env: NodeJS.ProcessEnv,
  defaultExplainer: string,
): void {
  for (const warning of settings.warnings) {
    stderr.write(`${warning}\n`);
  }
  const envMode = env.TENJIN_PUBLISH_MODE;
  if (
    envMode !== undefined &&
    envMode.length > 0 &&
    !PublishModeSchema.safeParse(envMode).success
  ) {
    stderr.write(
      `Ignoring invalid TENJIN_PUBLISH_MODE=${JSON.stringify(envMode)}; using ${settings.mode} (${settings.modeSource}).\n`,
    );
  }
  if (settings.modeSource === 'default') {
    stderr.write(
      `publish.mode: ${settings.mode} (default) - ${defaultExplainer}: tenjin config set publish.mode auto.\n`,
    );
  }
}

/** A finding safe to echo: block excerpts are already masked by the scanner. */
export function publicFinding(f: ScanFinding): {
  check: string;
  severity: string;
  line: number;
  excerpt: string;
} {
  return { check: f.check, severity: f.severity, line: f.line, excerpt: f.excerpt };
}

/**
 * Collapse findings that share a check + excerpt to one, keeping the first. The
 * same value scanned twice (a frontmatter field present in both the raw file and
 * the derived card) is one finding, not two.
 */
export function dedupeFindings(findings: ScanFinding[]): ScanFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.check}:${f.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "N secret finding(s) (check, check)" — the shared half of both block messages. */
export function describeFindings(blocking: ScanFinding[]): string {
  const checks = [...new Set(blocking.map((f) => f.check))].join(', ');
  return `${blocking.length} secret finding(s) (${checks})`;
}
