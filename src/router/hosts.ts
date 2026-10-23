import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext, CommandResult } from '../context';
import { writeFileAtomic } from '../lib/atomic-json';
import { CliError } from '../lib/errors';
import { HARNESSES, type Harness } from './names';
import type { UninstallTarget } from './uninstall';

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

/**
 * Is the Claude Code plugin here already, from a release that wrote no record?
 * Claude Code's own plugin list file, as doctor reads it with no binary, or
 * the plugin folder of ours at user scope.
 */
export async function claudePluginPresent(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<boolean> {
  const [{ listedInClaudeFiles }, { folderState }] = await Promise.all([
    import('./doctor'),
    import('./plugin-registration'),
  ]);
  if (await listedInClaudeFiles(env, home)) return true;
  return (await folderState('user', env, home, home)).state === 'ours';
}

/**
 * A host whose setup finished. The first record on a machine whose Claude
 * Code plugin came from a release before the record starts with Claude Code,
 * so doctor and uninstall keep covering it.
 */
export async function recordInstalledHost(
  dataDir: string,
  host: Harness,
  present: () => Promise<boolean> = () => claudePluginPresent(),
): Promise<void> {
  const recorded = await readInstalledHosts(dataDir);
  const hosts =
    recorded ?? (host !== 'claude' && (await present().catch(() => false)) ? ['claude'] : []);
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

/**
 * Under an agent, the line naming the other host when its `--version` runs
 * too: a yes/no question the agent asks the person, and what a yes runs.
 */
export async function otherHostNote(
  args: InstallHostArgs,
  deps: HostDeps = {},
): Promise<string | undefined> {
  if (args.harness !== undefined || args.refresh === true || args.project === true) {
    return undefined;
  }
  const env = deps.env ?? process.env;
  const agent = agentHost(env);
  if (agent === undefined) return undefined;
  const other: Harness = agent === 'claude' ? 'codex' : 'claude';
  if (!(await (deps.detect ?? detectHosts)(env)).includes(other)) return undefined;
  return `${LABEL[other]} is also installed on this machine. Ask the person: "Should I also set up Tenjin for ${LABEL[other]}?" On yes, run \`tenjin install --harness ${other}\`.`;
}

/** The install result with `note` in its `notices` and as its last line. */
export function withNote(out: CommandResult, note: string | undefined): CommandResult {
  if (note === undefined) return out;
  const data = (out.data ?? {}) as { notices?: unknown };
  const notices = Array.isArray(data.notices) ? (data.notices as string[]) : [];
  return {
    data: { ...data, notices: [...notices, note] },
    humanLines: [...(out.humanLines ?? []), note],
  };
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

/** What every install shares (Tenjin's runtime and its launcher), as uninstall settles it last. */
export interface SharedParts {
  /** Removes them; their result is appended to the run's. */
  remove: () => Promise<CommandResult>;
  /** Whether Claude Code still holds an install anywhere; asked only when this run did not remove Claude Code's. */
  claudeLeft: () => Promise<boolean>;
  /** The line saying they were kept for these hosts, or null where there are none (a data dir of its own). */
  keptFor: (hosts: string[]) => string | null;
}

/**
 * Uninstall over the hosts: a host leaves the record only once its removal
 * left nothing behind. Claude Code leaves it when no install of it is left in
 * any scope or project (its result's `remaining` is empty); Codex, user scope
 * only, when its removal succeeded. A host whose removal failed (it throws)
 * stays recorded, so a later uninstall or doctor still finds it, and every
 * host is tried before one aggregated refusal.
 *
 * `shared` IS SETTLED BY THE END STATE, last: removed only when every host
 * succeeded, no host is still recorded, and Claude Code holds no install
 * (this run's `remaining` is empty, or, when Claude Code was not part of this
 * run, it records none), so the last host removed takes them whichever it is.
 * Kept, and said so, when only another recorded host still uses them.
 */
export async function uninstallEach(
  hosts: readonly Harness[],
  dataDir: string,
  target: UninstallTarget,
  run: (host: Harness) => Promise<CommandResult>,
  shared?: SharedParts,
): Promise<CommandResult> {
  const done: { host: Harness; out: CommandResult }[] = [];
  const failed: { host: Harness; err: CliError }[] = [];
  let claudeGone = false;
  for (const host of hosts) {
    try {
      const out = await run(host);
      done.push({ host, out });
      const gone = host === 'claude' ? nothingRemains(out.data) : target.kind !== 'project';
      if (gone) await forgetInstalledHost(dataDir, host);
      if (host === 'claude') claudeGone = gone;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      failed.push({ host, err });
    }
  }
  const [only] = done;
  if (failed.length > 0) {
    const [first] = failed;
    if (hosts.length === 1 && first !== undefined) throw first.err;
    const data: Record<string, unknown> = { hosts };
    for (const { host, out } of done) data[host] = out.data;
    for (const { host, err } of failed) {
      data[host] = {
        error: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
    }
    throw new CliError(
      'REFUSED',
      failed.map(({ host, err }) => `${LABEL[host]}: ${err.message}`).join(' '),
      {
        details: data,
        fix: failed.map(({ host, err }) => `${LABEL[host]}:\n${err.fix ?? err.message}`).join('\n'),
      },
    );
  }
  // One host keeps its own result shape, as runEach does.
  const out: CommandResult =
    hosts.length === 1 && only !== undefined
      ? only.out
      : {
          data: Object.fromEntries([['hosts', hosts], ...done.map((d) => [d.host, d.out.data])]),
          humanLines: done.flatMap((d) => [
            `${LABEL[d.host]}:`,
            ...(d.out.humanLines ?? []).map((l) => `  ${l}`),
          ]),
        };
  if (shared === undefined) return out;
  // Claude Code's own result already names what it keeps for its installs.
  const claudeRan = done.some((d) => d.host === 'claude');
  if (claudeRan ? !claudeGone : await shared.claudeLeft()) return out;
  const recorded = (await readInstalledHosts(dataDir)) ?? [];
  if (recorded.length > 0) {
    const line = shared.keptFor(recorded.map((h) => LABEL[h]));
    return line === null ? out : { ...out, humanLines: [...(out.humanLines ?? []), line] };
  }
  const removed = await shared.remove();
  return {
    data: {
      ...(out.data as Record<string, unknown>),
      ...(removed.data as Record<string, unknown>),
    },
    humanLines: [...(out.humanLines ?? []), ...(removed.humanLines ?? [])],
  };
}

/** The Claude Code removal's `remaining: []`: no install of it is left anywhere. */
function nothingRemains(data: unknown): boolean {
  const remaining = (data as { remaining?: unknown } | null)?.remaining;
  return Array.isArray(remaining) && remaining.length === 0;
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
