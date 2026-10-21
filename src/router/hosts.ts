import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandContext, CommandResult } from '../context';
import { writeFileAtomic } from '../lib/atomic-json';
import { CliError } from '../lib/errors';
import { HARNESSES, type Harness } from './names';

/**
 * WHICH AGENT HOSTS `install`, `doctor` AND `uninstall` SERVE. Nobody names a
 * host on the normal path: an agent's install goes to the host it runs in, a
 * terminal install to the hosts this machine has (asking when it has both),
 * and doctor and uninstall read the hosts install recorded. `--harness` only
 * overrides.
 */

/** The record install writes in the Tenjin data dir: the hosts it set up. */
export const HOSTS_FILE = 'installed-hosts.json';

const LABEL: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };

/** The hosts install recorded, or null on a machine set up before the record. */
export async function readInstalledHosts(dataDir: string): Promise<Harness[] | null> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, HOSTS_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const hosts = (JSON.parse(raw) as { hosts?: unknown }).hosts;
    if (!Array.isArray(hosts)) return null;
    return HARNESSES.filter((h) => hosts.includes(h));
  } catch {
    return null;
  }
}

async function writeHosts(dataDir: string, hosts: readonly Harness[]): Promise<void> {
  const path = join(dataDir, HOSTS_FILE);
  if (hosts.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeFileAtomic(path, `${JSON.stringify({ hosts }, null, 2)}\n`, { mode: 0o600 });
}

export async function recordInstalledHost(dataDir: string, host: Harness): Promise<void> {
  const hosts = (await readInstalledHosts(dataDir)) ?? [];
  if (hosts.includes(host)) return;
  await writeHosts(
    dataDir,
    HARNESSES.filter((h) => h === host || hosts.includes(h)),
  );
}

export async function forgetInstalledHost(dataDir: string, host: Harness): Promise<void> {
  const hosts = await readInstalledHosts(dataDir);
  if (hosts === null || !hosts.includes(host)) return;
  await writeHosts(
    dataDir,
    hosts.filter((h) => h !== host),
  );
}

/**
 * The host whose agent runs this command, from the variables each exports, or
 * undefined in a person's own terminal. A Claude Code variable wins when both
 * are set, as `readActor` reads them.
 */
export function agentHost(env: NodeJS.ProcessEnv): Harness | undefined {
  const set = (v: string | undefined) => typeof v === 'string' && v.trim().length > 0;
  if (set(env.CLAUDECODE) || set(env.CLAUDE_CODE_SESSION_ID) || set(env.CLAUDE_CODE_EXECPATH)) {
    return 'claude';
  }
  if (set(env.CODEX_SESSION_ID)) return 'codex';
  return undefined;
}

/** The hosts this machine can run: each counts only when its `--version` answers. */
export async function detectHosts(env: NodeJS.ProcessEnv): Promise<Harness[]> {
  const [{ readClaudeCode }, { codexVersion }] = await Promise.all([
    import('./claude-cli'),
    import('./codex-host'),
  ]);
  const [claude, codex] = await Promise.all([
    readClaudeCode(env, process.cwd()).then(
      (s) => s.version !== null,
      () => false,
    ),
    codexVersion().then(
      (v) => v !== null,
      () => false,
    ),
  ]);
  return HARNESSES.filter((h) => (h === 'claude' ? claude : codex));
}

async function askHosts(found: readonly Harness[]): Promise<Harness[] | null> {
  const { selectMany } = await import('../lib/clack');
  return selectMany<Harness>({
    message: 'Set up Tenjin for which agents?',
    choices: found.map((h) => ({ value: h, label: LABEL[h] })),
    initialValues: found,
  });
}

export interface HostDeps {
  env?: NodeJS.ProcessEnv;
  detect?: (env: NodeJS.ProcessEnv) => Promise<Harness[]>;
  ask?: (found: readonly Harness[]) => Promise<Harness[] | null>;
  isInteractive?: boolean;
}

export interface InstallHostArgs {
  harness?: Harness;
  project?: boolean;
  refresh?: boolean;
  yes?: boolean;
}

/**
 * The hosts this install sets up. A refresh and a project install are Claude
 * Code's alone; an agent's install goes to its own host; a terminal install
 * goes to every host found, asking first when there are two and a person can
 * answer. A machine with neither gets the Claude Code setup, which needs no
 * `claude` binary.
 */
export async function installHosts(
  args: InstallHostArgs,
  ctx: CommandContext,
  deps: HostDeps = {},
): Promise<Harness[]> {
  if (args.harness !== undefined) return [args.harness];
  if (args.refresh === true || args.project === true) return ['claude'];
  const env = deps.env ?? process.env;
  const agent = agentHost(env);
  if (agent !== undefined) return [agent];
  const found = await (deps.detect ?? detectHosts)(env);
  if (found.length === 0) return ['claude'];
  if (found.length === 1 || args.yes === true) return found;
  const interactive =
    ctx.flags.json !== true &&
    (deps.isInteractive ?? (ctx.io.isTTY && Boolean(process.stdin.isTTY)));
  if (!interactive) return found;
  const picked = await (deps.ask ?? askHosts)(found);
  if (picked === null || picked.length === 0) {
    throw new CliError('REFUSED', 'Install cancelled before anything was written.', {
      fix: 'Re-run `tenjin install` and pick at least one agent.',
    });
  }
  return HARNESSES.filter((h) => picked.includes(h));
}

/** The hosts doctor checks and uninstall removes: the record, else Claude Code. */
export async function recordedHosts(
  args: { harness?: Harness; project?: boolean },
  dataDir: string,
): Promise<Harness[]> {
  if (args.harness !== undefined) return [args.harness];
  if (args.project === true) return ['claude'];
  const hosts = await readInstalledHosts(dataDir);
  return hosts === null || hosts.length === 0 ? ['claude'] : hosts;
}

/** One run per host, in order. One host keeps its own result shape. */
export async function runEach(
  hosts: readonly Harness[],
  run: (host: Harness) => Promise<CommandResult>,
): Promise<CommandResult> {
  const [only] = hosts;
  if (hosts.length === 1 && only !== undefined) return run(only);
  const data: Record<string, unknown> = { hosts };
  const humanLines: string[] = [];
  for (const host of hosts) {
    const out = await run(host);
    data[host] = out.data;
    humanLines.push(`${LABEL[host]}:`, ...(out.humanLines ?? []).map((l) => `  ${l}`));
  }
  return { data, humanLines };
}

/**
 * Doctor over several hosts: every host is checked before any failure is
 * reported, and the failure names each host that failed.
 */
export async function checkEach(
  hosts: readonly Harness[],
  run: (host: Harness) => Promise<CommandResult>,
): Promise<CommandResult> {
  const [only] = hosts;
  if (hosts.length === 1 && only !== undefined) return run(only);
  const data: Record<string, unknown> = { hosts };
  const humanLines: string[] = [];
  const failed: { host: Harness; err: CliError }[] = [];
  for (const host of hosts) {
    try {
      const out = await run(host);
      data[host] = out.data;
      humanLines.push(`${LABEL[host]}:`, ...(out.humanLines ?? []).map((l) => `  ${l}`));
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      data[host] = {
        error: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
      failed.push({ host, err });
    }
  }
  if (failed.length === 0) return { data, humanLines };
  throw new CliError(
    'REFUSED',
    failed.map(({ host, err }) => `${LABEL[host]}: ${err.message}`).join(' '),
    {
      details: data,
      fix: failed.map(({ host, err }) => `${LABEL[host]}:\n${err.fix ?? err.message}`).join('\n'),
    },
  );
}
