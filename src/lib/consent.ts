import { createSessionKeyAuth, createSiwxAuth, SESSION_CHAIN_ID } from './session-key';
import type { SessionScope, WriteAuth } from './session-key';
import type { AckServerWarnings, PublishMode } from './config';
import { PublishModeSchema } from './config';
import { CliError } from './errors';
import { ScanGateError } from './posts-api';
import { describeRendered, mergeFindings } from './scan-gate';
import type { RenderedFinding, ScanGateRejection } from './scan-gate';
import type { ResolvedPublishSettings } from './settings';
import type { Finding } from './redact';
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

/** The inputs {@link acksServerWarnings} decides on. */
export interface ServerAckInput {
  mode: PublishMode;
  /** `--yes` on THIS run. */
  yes: boolean;
  /** `publish.ackServerWarnings`; `mode` (the default) derives from the rest. */
  setting: AckServerWarnings;
  /** A caller whose answer is fixed whatever the mode or the config say. */
  override?: boolean;
  /**
   * True when the merged set holds a finding the SERVER contributed and the
   * local pass did not, i.e. one no earlier render of this content can have
   * shown the operator.
   */
  serverAddedUnseen: boolean;
}

/**
 * Whether this run may acknowledge the SERVER gate's warn findings on the
 * operator's behalf.
 *
 * THE RULE IS THAT A CONFIRMATION MUST POST-DATE THE FINDINGS IT COVERS. A
 * `--yes` is an answer to a payload, and the payload it answered was rendered by
 * an earlier run of this same content: the local scan's warns, and nothing else,
 * because no server call had happened yet. The server's set is strictly larger,
 * and the semantic judge's verdicts cannot come from the local corpus at all, so
 * reading that yes as an answer to findings the server added later is reading it
 * as an answer to a question nobody asked. `serverAddedUnseen` is exactly that
 * difference, and a yes does not clear it.
 *
 * `full-auto` still acks unasked, because that is the mode's whole contract: it
 * clears soft findings without rendering them, and a server warn is a soft
 * finding. The narrowing lands on `review` and `auto`, where the ladder the
 * changeset advertises now actually holds.
 *
 * The escape hatches, both deliberate and both narrow:
 *   - `setting: 'off'` never acks, whatever the mode says. This is the switch a
 *     `full-auto` dogfood machine turns on without changing its mode.
 *   - `setting: 'on'` is the operator's standing yes for server findings, made
 *     once, out of band, by a `config set` that is itself a deliberate act. It
 *     still requires a yes for the run: it restores the pre-gate reading of
 *     `--yes` and never manufactures one, so no configuration of this function
 *     acks anything the previous `yes || full-auto` rule would not have.
 *   - `override` is for a caller whose answer is never yes whatever the mode:
 *     the session observer (commands/publish.ts `PublishDeps.ackServerWarnings`)
 *     publishes unattended, so a server warn must drop its candidate to draft.
 *     Keeping that a parameter rather than a second mode is what stops the
 *     observer's rule from being re-derived from `publish.mode`, which it is
 *     deliberately orthogonal to.
 */
export function acksServerWarnings(input: ServerAckInput): boolean {
  if (input.override !== undefined) return input.override;
  if (input.setting === 'off') return false;
  if (input.mode === 'full-auto') return true;
  if (!input.yes) return false;
  return input.setting === 'on' || !input.serverAddedUnseen;
}

export interface ScanGateFlow<T> {
  /** Perform the write; called a second time with the ack token on an approved yes. */
  send: (scanAck?: string) => Promise<T>;
  /** This run's local scan warns, so the server's merge in rather than repeat. */
  localWarns: Finding[];
  mode: PublishMode;
  yes: boolean;
  /** `publish.ackServerWarnings`; see {@link acksServerWarnings}. */
  ackSetting: AckServerWarnings;
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
 * The gate's rejection as a refusal payload. `findings` is what the operator is
 * being shown, and `scan.source` says who found it, so a detector this release
 * predates still renders as the marketplace's word rather than as advice about
 * the local file.
 */
function gateDetails<T>(
  flow: ScanGateFlow<T>,
  rejection: ScanGateRejection,
  findings: RenderedFinding[],
): Record<string, unknown> {
  const { semantic } = rejection.report;
  return {
    ...flow.detail,
    findings,
    scan: { source: 'server', ...(semantic !== undefined ? { semantic } : {}) },
  };
}

/**
 * The server ingest gate's half of the consent flow (lib/scan-gate.ts parses the
 * wire; server sibling tenjin#723), shared by `publish` and `edit` for the same
 * reason the rest of this file is: an edit ships content to the same public page
 * a publish does, and a second copy of a gate is a gate that drifts.
 *
 * A `scan_blocked` is terminal in every mode — there is no acknowledgement path
 * server-side, so there is none here. A `scan_needs_ack` merges the server's
 * findings with the local scan's, renders them ONCE through the same exit-3
 * payload a local warn already uses, and re-runs the identical content carrying
 * the token only when {@link acksServerWarnings} says yes, which a `--yes` alone
 * no longer does once the server contributed something the local pass never
 * rendered.
 *
 * There is no interactive re-prompt here, deliberately. Exit 3 with the payload
 * IS this CLI's confirmation channel, the one the MCP `NEEDS_CONFIRMATION`
 * surface and the skill both drive, so a second, terminal-only prompt would be
 * a second consent channel that only one of the two surfaces could answer.
 *
 * Exactly one ack retry. The token is bound to this content and this finding
 * set, so a second `needs_ack` is the server answering a question we did not
 * ask; looping on it would re-sign and resend the same body indefinitely.
 */
export async function throughScanGate<T>(flow: ScanGateFlow<T>): Promise<T> {
  let rejection: ScanGateRejection;
  try {
    return await flow.send();
  } catch (err) {
    if (!(err instanceof ScanGateError)) throw err;
    rejection = err.rejection;
  }

  // A BLOCK IS THE SERVER'S SET AND NOTHING ELSE. Merging the local warns in put
  // non-blocking material in a message that then told the operator to remove it,
  // and left the local block path (which names only its blocking findings) and
  // this one saying different things about the same refusal.
  if (rejection.kind === 'blocked') {
    const blocked = mergeFindings([], rejection.report.findings);
    throw new CliError(
      'PUBLISH_BLOCKED',
      `${flow.noun} blocked by the marketplace scan: ${describeRendered(blocked)}.`,
      {
        fix: 'Remove the block-tier material from the content (the block tier has no acknowledgement path), then re-run.',
        details: gateDetails(flow, rejection, blocked),
      },
    );
  }

  const findings = mergeFindings(flow.localWarns, rejection.report.findings);
  const serverAddedUnseen = findings.some((f) => f.source === 'server');
  const token = rejection.report.ackToken;
  const acks = acksServerWarnings({
    mode: flow.mode,
    yes: flow.yes,
    setting: flow.ackSetting,
    ...(flow.ackOverride !== undefined ? { override: flow.ackOverride } : {}),
    serverAddedUnseen,
  });
  if (token === undefined || !acks) {
    throw new CliError(
      'NEEDS_CONFIRMATION',
      `${flow.noun} held by the marketplace scan: ${describeRendered(findings)}${flow.heldSuffix ?? ''}.`,
      {
        fix: heldFix(flow, token !== undefined, serverAddedUnseen),
        details: gateDetails(flow, rejection, findings),
      },
    );
  }

  try {
    return await flow.send(token);
  } catch (err) {
    if (!(err instanceof ScanGateError)) throw err;
    // The retry's own rejection, wrapped the same way the first one is. Raw, it
    // reached the renderer as ScanGateError's unmerged details: no `source`, so
    // the marketplace's findings printed as if the local scan had found them.
    const retried = mergeFindings([], err.rejection.report.findings);
    const blocked = err.rejection.kind === 'blocked';
    throw new CliError(
      blocked ? 'PUBLISH_BLOCKED' : 'NEEDS_CONFIRMATION',
      `${flow.noun} refused by the marketplace scan after the acknowledgement: ${describeRendered(retried)}.`,
      {
        fix: blocked
          ? 'Remove the block-tier material from the content (the block tier has no acknowledgement path), then re-run.'
          : 'The acknowledgement did not settle the gate, and it is never retried twice. Resolve the findings in the content, then re-run.',
        details: gateDetails(flow, err.rejection, retried),
      },
    );
  }
}

/**
 * What the operator does next about a held write.
 *
 * ADVISE `--yes` ONLY WHERE A `--yes` WOULD ACTUALLY ACK, and settle that by
 * asking {@link acksServerWarnings} itself, with `yes: true`, about the run the
 * operator is being sent to make. Deciding it here on `flow.yes` alone read the
 * flag and ignored the setting and the override that also gate the ack, so the
 * payload advised a re-run that provably could not clear the hold: under
 * `ackServerWarnings off` that is an infinite loop, and the skill's "follow that
 * payload's own fix" rule cannot escape a fix that is itself the loop.
 *
 * Then the three ways a `--yes` cannot help, which are three different remedies:
 * a caller that never acks whatever the operator configures, the operator's own
 * standing `off`, and the ordinary case where the marketplace found something
 * the local pass never rendered.
 */
function heldFix<T>(flow: ScanGateFlow<T>, hasToken: boolean, serverAddedUnseen: boolean): string {
  if (!hasToken) return 'Resolve the findings in the content, then re-run.';
  const yesWouldAck = acksServerWarnings({
    mode: flow.mode,
    yes: true,
    setting: flow.ackSetting,
    ...(flow.ackOverride !== undefined ? { override: flow.ackOverride } : {}),
    serverAddedUnseen,
  });
  if (yesWouldAck) {
    return 'Review the findings, then re-run with --yes to proceed anyway (or resolve them in the content).';
  }
  if (flow.ackOverride === false) {
    return 'This run never acknowledges marketplace findings, whatever the mode or the config say. Resolve them in the content, then re-run.';
  }
  if (flow.ackSetting === 'off') {
    return 'publish.ackServerWarnings is off, so no --yes acknowledges a marketplace finding. Resolve them in the content, or change that setting deliberately with `tenjin config set publish.ackServerWarnings mode`.';
  }
  return (
    'These came from the marketplace rather than the local scan, so a --yes does not cover them: ' +
    'a --yes answers the payload rendered before the marketplace was asked. ' +
    'Resolve them in the content, or acknowledge marketplace findings standingly with ' +
    '`tenjin config set publish.ackServerWarnings on` and re-run with --yes.'
  );
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
export function publicFinding(f: Finding): {
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
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.check}:${f.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "N secret finding(s) (check, check)" — the shared half of both block messages. */
export function describeFindings(blocking: Finding[]): string {
  const checks = [...new Set(blocking.map((f) => f.check))].join(', ');
  return `${blocking.length} secret finding(s) (${checks})`;
}
