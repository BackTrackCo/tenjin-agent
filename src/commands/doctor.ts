import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { CliError } from '../lib/errors';
import { fetchJson, trimSlash } from '../lib/http';
import { baseHeaders } from '../lib/api';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { configPath } from '../lib/paths';
import { toMoney } from '../lib/money';
import { walletFileExists } from '../lib/wallet/store';
import type { PartialConfig } from '../lib/config';
import type { ErrorCode } from '../schemas';
import type { Io } from '../lib/output';
import type { WalletDescription, WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * One environment/reachability check. The doctor agent builds the check list
 * against this shape without changing it: `required` drives the exit code (exit
 * 0 iff every required check is ok), `status` drives the TTY rendering, and a
 * `fix` is mandatory on every failure (spec 10). Warn-level checks never fail
 * the command.
 */
export interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  required: boolean;
  detail: string;
  fix?: string;
}

/**
 * A CheckResult plus the error code to raise if it is a *required* failure. Only
 * required checks carry a `failCode`; the outcome step raises the first one, so
 * the failure envelope's `error.code` names what actually broke (api-contract
 * unreachable vs malformed differ) while still carrying the whole check list.
 */
interface BuiltCheck {
  result: CheckResult;
  failCode?: ErrorCode;
  /** Set by api-contract when the fetched OpenAPI document lacks the A2 lookup path. */
  lookupMissing?: boolean;
}

export interface DoctorDeps {
  /** Environment for wallet-key detection and settings precedence. */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch for the reachability checks; tests pass a canned stub. */
  fetchImpl?: typeof fetch;
  /** Inject the active wallet provider. When set, NO local fs/env is consulted —
   * the provider owns its own describe() and diagnostics(), so a remote provider's
   * checks can't be contaminated by a stale local wallet file. */
  provider?: WalletProvider;
}

export async function runDoctor(
  ctx: CommandContext,
  deps: DoctorDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const { config, check: configCheck } = await loadConfigForDoctor(ctx.dataDir);
  const settings = resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env });
  const baseUrl = settings.baseUrl.value;

  const apiContract = await checkApiContract(baseUrl, ctx.flags.timeout, deps.fetchImpl);
  const built: BuiltCheck[] = [
    checkNode(),
    configCheck,
    apiContract,
    { result: lookupContractCheck(apiContract) },
    await checkReadPath(baseUrl, ctx.flags.timeout, deps.fetchImpl),
  ];

  // The wallet/custody/balance checks all come from the ACTIVE provider: it owns
  // describe() and diagnostics(), so doctor never runs its own fs/env probe.
  for (const result of await checkWallet(ctx, deps, env, settings.rpcUrl.value)) {
    built.push({ result });
  }

  const checks = built.map((b) => b.result);
  const firstFail = built.find((b) => b.result.required && b.result.status === 'fail');
  if (firstFail !== undefined) {
    const r = firstFail.result;
    throw new CliError(firstFail.failCode ?? 'INTERNAL', r.detail, {
      ...(r.fix !== undefined ? { fix: r.fix } : {}),
      details: { checks },
    });
  }

  return { data: { status: 'pass', checks }, humanLines: renderHuman(ctx.io, checks) };
}

function checkNode(): BuiltCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  if (major >= 22) {
    return { result: { name: 'node', status: 'ok', required: true, detail: `Node ${version}` } };
  }
  return {
    result: {
      name: 'node',
      status: 'fail',
      required: true,
      detail: `Node ${version} is unsupported (need >= 22)`,
      fix: 'Install Node 22 or newer',
    },
    failCode: 'NODE_UNSUPPORTED',
  };
}

/**
 * loadRawConfig throws CONFIG_INVALID on a bad file (which we convert into a
 * failing check) but the config value is also needed for baseUrl/rpcUrl
 * resolution; an invalid file falls back to {} so the reachability checks still
 * run and appear in the list, and config is reported as the first required fail.
 */
async function loadConfigForDoctor(
  dataDir: string,
): Promise<{ config: PartialConfig; check: BuiltCheck }> {
  try {
    const config = await loadRawConfig(dataDir);
    const detail =
      Object.keys(config).length === 0
        ? 'No config file; using defaults'
        : `Config at ${configPath(dataDir)} is valid`;
    return { config, check: { result: { name: 'config', status: 'ok', required: true, detail } } };
  } catch (err) {
    if (err instanceof CliError && err.code === 'CONFIG_INVALID') {
      return {
        config: {},
        check: {
          result: {
            name: 'config',
            status: 'fail',
            required: true,
            detail: err.message,
            ...(err.fix !== undefined ? { fix: err.fix } : {}),
          },
          failCode: 'CONFIG_INVALID',
        },
      };
    }
    throw err;
  }
}

async function checkApiContract(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<BuiltCheck> {
  const url = `${trimSlash(baseUrl)}/openapi.json`;
  const res = await fetchJson(url, { timeoutMs, fetchImpl, headers: baseHeaders() });
  if (!res.ok) {
    const malformed = res.kind === 'invalid-json';
    return {
      result: {
        name: 'api-contract',
        status: 'fail',
        required: true,
        detail: malformed
          ? `OpenAPI document at ${url} was not valid JSON`
          : `Could not reach the Tenjin API at ${url}: ${res.message}`,
        fix: malformed
          ? 'Point --base-url at a Tenjin API (expected an OpenAPI document).'
          : 'Check your network connection and --base-url.',
      },
      failCode: malformed ? 'CONTRACT_MISMATCH' : 'API_UNREACHABLE',
    };
  }
  const version = infoVersion(res.json);
  if (version === undefined) {
    return {
      result: {
        name: 'api-contract',
        status: 'fail',
        required: true,
        detail: `OpenAPI document at ${url} is missing a string info.version`,
        fix: 'Point --base-url at a Tenjin API (expected an OpenAPI document).',
      },
      failCode: 'CONTRACT_MISMATCH',
    };
  }
  return {
    result: {
      name: 'api-contract',
      status: 'ok',
      required: true,
      detail: `Tenjin API ${version} at ${baseUrl}`,
    },
    ...(hasLookupPath(res.json) ? {} : { lookupMissing: true }),
  };
}

/**
 * The B2 lookup contract, derived from the SAME openapi fetch as api-contract
 * (no second request). Warn-level: an older deployment without /api/agent/lookup
 * still serves reads and buys; only `tenjin lookup` would 404 against it.
 */
function lookupContractCheck(apiContract: BuiltCheck): CheckResult {
  if (apiContract.result.status !== 'ok') {
    return {
      name: 'lookup-contract',
      status: 'warn',
      required: false,
      detail: 'Skipped: the OpenAPI document was not readable',
    };
  }
  if (apiContract.lookupMissing === true) {
    return {
      name: 'lookup-contract',
      status: 'warn',
      required: false,
      detail: 'This deployment does not advertise POST /api/agent/lookup',
      fix: 'Point --base-url at a deployment with the A2 lookup contract, or skip `tenjin lookup`.',
    };
  }
  return {
    name: 'lookup-contract',
    status: 'ok',
    required: false,
    detail: 'POST /api/agent/lookup is advertised',
  };
}

function hasLookupPath(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const paths = json.paths;
  return isRecord(paths) && isRecord(paths['/api/agent/lookup']);
}

async function checkReadPath(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<BuiltCheck> {
  // The shipped public read path. The A2 lookup-contract check is a B2 follow-up.
  // Probe the UNFILTERED listing: the server logs every nonblank first-page `q`
  // as agent search demand, so a `q` here would fabricate that demand into the
  // experiment this CLI exists to measure. Never add a `q` to this probe.
  const url = `${trimSlash(baseUrl)}/api/articles?limit=1`;
  const res = await fetchJson(url, { timeoutMs, fetchImpl, headers: baseHeaders() });
  if (!res.ok) {
    return {
      result: {
        name: 'read-path',
        status: 'fail',
        required: true,
        detail: `Read path ${url} failed: ${res.message}`,
        fix: 'Check your network connection and --base-url.',
      },
      failCode: 'API_UNREACHABLE',
    };
  }
  const items = isRecord(res.json) ? res.json.items : undefined;
  if (!Array.isArray(items)) {
    return {
      result: {
        name: 'read-path',
        status: 'fail',
        required: true,
        detail: `Read path ${url} did not return an items array`,
        fix: 'Point --base-url at a Tenjin API.',
      },
      failCode: 'API_UNREACHABLE',
    };
  }
  return {
    result: { name: 'read-path', status: 'ok', required: true, detail: `Read path OK at ${url}` },
  };
}

/**
 * Diagnose the wallet the CLI would actually use, entirely through the ACTIVE
 * provider. An injected provider owns everything — no local file or env is touched.
 * With no injected provider we do ONE cheap fs/env probe purely to decide whether
 * any credential exists: none → emit the "no wallet" warn WITHOUT importing the
 * wallet lib (that import statically pulls viem, and a no-wallet run must not parse
 * it). Otherwise the provider describes itself (address + source), reports its own
 * custody warnings, and the balance probes describe()'s address. A custody problem
 * (bad key, provider refusal) is warn-level, never a hard fail.
 */
async function checkWallet(
  ctx: CommandContext,
  deps: DoctorDeps,
  env: NodeJS.ProcessEnv,
  rpcUrl: string,
): Promise<CheckResult[]> {
  const provider = deps.provider ?? (await resolveLocalProviderOrNull(ctx, env));
  if (provider === null) return [noWalletCheck()];

  const { describeWallet } = await import('../lib/wallet');
  let desc: WalletDescription;
  try {
    desc = await describeWallet(provider);
  } catch (err) {
    if (err instanceof CliError && err.code === 'WALLET_MISSING') return [noWalletCheck()];
    return [walletWarn(err)];
  }

  const checks: CheckResult[] = [
    {
      name: 'wallet',
      status: 'ok',
      required: false,
      detail: `Wallet ${desc.address} (${desc.credentialSource})`,
    },
  ];
  // Custody warnings are the provider's own (perms, env-shadow for the local
  // provider; none for a remote one). Render each as a warn check; the fix text,
  // when there is one, is carried inline in the warning string.
  for (const warning of (await provider.diagnostics()).warnings) {
    checks.push({ name: 'wallet-custody', status: 'warn', required: false, detail: warning });
  }
  checks.push(await checkBalance(desc.address, rpcUrl));
  return checks;
}

/**
 * The active local provider, or null when no credential exists at all. The null
 * path never imports the wallet lib, keeping a no-wallet doctor run off viem.
 */
async function resolveLocalProviderOrNull(
  ctx: CommandContext,
  env: NodeJS.ProcessEnv,
): Promise<WalletProvider | null> {
  const envKey = env.TENJIN_WALLET_KEY;
  const envKeySet = typeof envKey === 'string' && envKey.length > 0;
  if (!envKeySet && !(await walletFileExists(ctx.dataDir))) return null;
  const { resolveWalletProvider } = await import('../lib/wallet');
  return resolveWalletProvider(ctx);
}

function noWalletCheck(): CheckResult {
  return {
    name: 'wallet',
    status: 'warn',
    required: false,
    detail: 'No wallet; needed only for buy/publish',
    fix: 'tenjin wallet create',
  };
}

function walletWarn(err: unknown): CheckResult {
  return {
    name: 'wallet',
    status: 'warn',
    required: false,
    detail: err instanceof Error ? err.message : String(err),
    ...(err instanceof CliError && err.fix !== undefined ? { fix: err.fix } : {}),
  };
}

/**
 * Balance is best-effort: a zero balance is a fundable warning and an RPC flake
 * must never fail doctor. viem loads only here, via a lazy import, so a doctor
 * run without a wallet never parses the viem chunk.
 */
const POCKET_MONEY_ATOMIC = 20_000_000n;

async function checkBalance(address: string, rpcUrl: string): Promise<CheckResult> {
  try {
    const { getUsdcBalance } = await import('../lib/usdc');
    const balance = await getUsdcBalance(address as `0x${string}`, rpcUrl);
    if (balance === 0n) {
      return {
        name: 'balance',
        status: 'warn',
        required: false,
        detail: 'Wallet USDC balance is 0',
        fix: 'Send USDC on Base. $5 covers ~50 typical resources.',
      };
    }
    const money = toMoney(balance.toString());
    // Pocket-money posture (D34): the balance, not key secrecy, is the real
    // security boundary of a hot agent wallet, so holding much more than you
    // plan to spend is the warning condition.
    if (balance > POCKET_MONEY_ATOMIC) {
      return {
        name: 'balance',
        status: 'warn',
        required: false,
        detail: `Balance ${money.usd} USDC exceeds the ~$20 pocket-money posture`,
        fix: 'Keep only what you plan to spend in this wallet; sweep the rest to a wallet you control.',
      };
    }
    return {
      name: 'balance',
      status: 'ok',
      required: false,
      detail: `Balance ${money.usd} USDC (${money.atomic} atomic)`,
    };
  } catch (err) {
    return {
      name: 'balance',
      status: 'warn',
      required: false,
      detail: `Could not read balance: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check rpcUrl or retry; a balance read failure never fails doctor.',
    };
  }
}

function renderHuman(io: Io, checks: CheckResult[]): string[] {
  const nameWidth = Math.max(...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    const icon =
      c.status === 'ok'
        ? paint(io, 'green', '✓')
        : c.status === 'warn'
          ? paint(io, 'yellow', '!')
          : paint(io, 'red', '✗');
    lines.push(`${icon} ${c.name.padEnd(nameWidth)}  ${paint(io, 'dim', c.detail)}`);
    if (c.status !== 'ok' && c.fix !== undefined) {
      lines.push(`    ${paint(io, 'dim', `fix: ${c.fix}`)}`);
    }
  }
  return lines;
}

/**
 * Color for stderr, honoring NO_COLOR and the target's color depth: styleText
 * takes the stderr stream when it is a genuine Stream (it throws on anything
 * else, so a test/redirected sink falls back to the default plain check).
 */
function paint(io: Io, format: Parameters<typeof styleText>[0], text: string): string {
  if (io.stderr instanceof Stream) return styleText(format, text, { stream: io.stderr });
  return styleText(format, text);
}

function infoVersion(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const info = json.info;
  if (!isRecord(info)) return undefined;
  return typeof info.version === 'string' ? info.version : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
