import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomicExclusive } from './atomic-json';
import { loadRawConfig, resolveSettings } from './config';
import { hasCode } from './errno';
import { setTenjinIdentity, type TenjinIdentity } from './http';
import { installIdPath } from './paths';
import { knownDeploymentOrigins } from './production-origin';
import { isTeamModeConfig } from './settings';

/**
 * The two telemetry values the transport attaches to Tenjin-bound requests (see
 * `TenjinIdentity` in lib/http), and the rule for which origins are Tenjin's.
 *
 * Nothing here may fail a request: every read that goes wrong is an absent
 * header. There is no opt-out for alpha; the values are an anonymous random id
 * and an address that is already public on chain, and neither is a credential.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseInstallId(raw: string): string | undefined {
  const id = raw.trim();
  return UUID_RE.test(id) ? id : undefined;
}

/**
 * This data dir's install id, minted on first need. Created no-clobber, so two
 * processes racing on a first run agree on the winner's id rather than each
 * keeping its own. A file that exists but does not hold a UUID is left alone and
 * sends nothing: overwriting it would be a new id for the same install.
 */
export async function readOrCreateInstallId(dir: string): Promise<string | undefined> {
  const path = installIdPath(dir);
  try {
    return parseInstallId(await readFile(path, 'utf8'));
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) return undefined;
  }
  const id = randomUUID();
  try {
    await writeFileAtomicExclusive(path, `${id}\n`, { mode: 0o600, dirMode: 0o700 });
    return id;
  } catch (err) {
    if (!hasCode(err, 'EEXIST')) return undefined;
  }
  try {
    return parseInstallId(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The wallet's public address, from the record's cleartext `address` field.
 * Never decrypts, never touches a keychain, never prompts. Loaded lazily so a
 * command that never talks to Tenjin does not parse the wallet module.
 */
export async function readWalletAddress(dir: string): Promise<string | undefined> {
  try {
    const { readWalletRecord } = await import('./wallet/store');
    return (await readWalletRecord(dir))?.address;
  } catch {
    return undefined;
  }
}

function tryOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The origins that get the headers: Tenjin's own deployments, the public
 * marketplace, and the base URL this run is pointed at, overrides included (a
 * local dev server is Tenjin too).
 *
 * NOT a team shelf. In team mode `baseUrl` is the team's own deployment, which
 * Tenjin does not operate, so on a team machine the base URL is left out unless
 * it is one of Tenjin's own origins anyway. `isTeamModeConfig` reads the file,
 * so a `--base-url` on one run cannot switch that exclusion off.
 */
export function tenjinOrigins(s: {
  baseUrl: string;
  publicShelfUrl: string;
  teamMode: boolean;
}): string[] {
  const origins = new Set(knownDeploymentOrigins());
  const publicOrigin = tryOrigin(s.publicShelfUrl);
  if (publicOrigin !== undefined) origins.add(publicOrigin);
  const baseOrigin = tryOrigin(s.baseUrl);
  if (baseOrigin !== undefined && !s.teamMode) origins.add(baseOrigin);
  return [...origins];
}

/**
 * An identity for one data dir. The install id is read once per process; the
 * wallet address is re-read per request, so a wallet created mid-session (the
 * MCP server, the daemon) is picked up without a restart.
 */
export function identityFor(
  dir: string,
  origins: () => Promise<readonly string[]>,
): TenjinIdentity {
  let install: Promise<string | undefined> | undefined;
  return {
    origins,
    values: async () => {
      install ??= readOrCreateInstallId(dir);
      const [id, wallet] = await Promise.all([install, readWalletAddress(dir)]);
      return {
        ...(id !== undefined ? { install: id } : {}),
        ...(wallet !== undefined ? { wallet } : {}),
      };
    },
  };
}

/**
 * The run's `--base-url`, recorded by the CLI once it has parsed the global
 * flags. The origins are resolved on the first request, which comes after that.
 */
let baseUrlFlag: string | undefined;

export function noteBaseUrlFlag(flag: string | undefined): void {
  baseUrlFlag = flag;
}

/**
 * Turn the headers on for this CLI process. Called from the entry only, never
 * from `main`, so in-process tests of the command tree never mint an id.
 */
export function enableCliIdentity(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  let origins: Promise<readonly string[]> | undefined;
  setTenjinIdentity(
    identityFor(dir, () => {
      origins ??= (async () => {
        const config = await loadRawConfig(dir);
        const s = resolveSettings({ config, flags: { baseUrl: baseUrlFlag }, env });
        return tenjinOrigins({
          baseUrl: s.baseUrl.value,
          publicShelfUrl: s.publicShelfUrl.value,
          teamMode: isTeamModeConfig(config),
        });
      })();
      return origins;
    }),
  );
}

/**
 * Turn the headers on for the loop daemon. No flag or env layer, like the rest
 * of the daemon's config, and re-read per request because the daemon reloads
 * config.json when it changes.
 */
export function enableDaemonIdentity(
  dir: string,
  config: () => { baseUrl: string; publicShelfUrl: string; shelfBypassSecret: string },
): void {
  setTenjinIdentity(
    identityFor(dir, async () => {
      const c = config();
      return tenjinOrigins({
        baseUrl: c.baseUrl,
        publicShelfUrl: c.publicShelfUrl,
        teamMode: isTeamModeConfig(c),
      });
    }),
  );
}
