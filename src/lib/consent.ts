import { createSessionKeyAuth, createSiwxAuth } from './session-key';
import type { SessionScope, WriteAuth } from './session-key';
import type { PublishMode } from './config';
import { PublishModeSchema } from './config';
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

/** Writes require Base mainnet per the server's SIWX chain constraint. */
export const WRITE_CHAIN_ID = 'eip155:8453';

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
