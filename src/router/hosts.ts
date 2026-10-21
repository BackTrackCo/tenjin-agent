import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandContext, CommandResult } from '../context';
import { writeFileAtomic } from '../lib/atomic-json';
import { CliError } from '../lib/errors';
import type { QuestionStep } from './install';
import { HARNESSES, type Harness } from './names';

/**
 * WHICH AGENT HOSTS `install`, `doctor` AND `uninstall` SERVE. Nobody names a
 * host on the normal path: an agent's install goes to the host it runs in, a
 * terminal install to the hosts this machine has (asking when it has both),
 * and doctor and uninstall read the hosts install recorded. `--harness` only
 * overrides.
 */

/**
 * The record install writes in the Tenjin data dir: the hosts the person
 * chose, written before any host is set up, and the hosts whose setup
 * finished. A chosen host that is not installed is one a re-run retries.
 */
export const HOSTS_FILE = 'installed-hosts.json';

const LABEL: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface HostRecord {
  chosen: Harness[];
  installed: Harness[];
}

const hostsIn = (v: unknown): Harness[] =>
  Array.isArray(v) ? HARNESSES.filter((h) => v.includes(h)) : [];

/** The record, or null on a machine set up before it (or with it unreadable). */
export async function readHostRecord(dataDir: string): Promise<HostRecord | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dataDir, HOSTS_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const row = raw as { chosen?: unknown; installed?: unknown };
  if (!Array.isArray(row.chosen) && !Array.isArray(row.installed)) return null;
  return { chosen: hostsIn(row.chosen), installed: hostsIn(row.installed) };
}

/** The hosts whose setup finished, or null with no record. */
export async function readInstalledHosts(dataDir: string): Promise<Harness[] | null> {
  return (await readHostRecord(dataDir))?.installed ?? null;
}

async function writeRecord(dataDir: string, record: HostRecord): Promise<void> {
  const path = join(dataDir, HOSTS_FILE);
  if (record.chosen.length === 0 && record.installed.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function updateRecord(dataDir: string, change: (r: HostRecord) => HostRecord): Promise<void> {
  const record = (await readHostRecord(dataDir)) ?? { chosen: [], installed: [] };
  const next = change(record);
  await writeRecord(dataDir, {
    chosen: HARNESSES.filter((h) => next.chosen.includes(h)),
    installed: HARNESSES.filter((h) => next.installed.includes(h)),
  });
}

/** Before any host is set up: add these hosts to the person's choice. */
export async function chooseHosts(dataDir: string, hosts: readonly Harness[]): Promise<void> {
  if (hosts.length === 0) return;
  await updateRecord(dataDir, (r) => ({ ...r, chosen: [...r.chosen, ...hosts] }));
}

/** A host whose setup finished. */
export async function recordInstalledHost(dataDir: string, host: Harness): Promise<void> {
  await updateRecord(dataDir, (r) => ({
    chosen: [...r.chosen, host],
    installed: [...r.installed, host],
  }));
}

/** A host uninstall removed: out of the choice and the installed set. */
export async function forgetInstalledHost(dataDir: string, host: Harness): Promise<void> {
  if ((await readHostRecord(dataDir)) === null) return;
  await updateRecord(dataDir, (r) => ({
    chosen: r.chosen.filter((h) => h !== host),
    installed: r.installed.filter((h) => h !== host),
  }));
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
  harness?: Harness[];
  project?: boolean;
  refresh?: boolean;
  yes?: boolean;
  /** Carried into the answer commands, so the re-run is this install. */
  noWallet?: boolean;
  maxAutoSpend?: string;
  sessionBudget?: string;
}

/** The hosts this install sets up, and the question it hands over, if any. */
export interface HostChoice {
  hosts: Harness[];
  /** Both hosts found and nobody answered: nothing is set up, and this asks. */
  ask?: QuestionStep;
}

/**
 * THE HOSTS THIS INSTALL SETS UP. A refresh and a project install are Claude
 * Code's alone, and `--harness` names the hosts. Otherwise every host found is
 * a candidate (the agent's own host counts as found). With one, install goes
 * there; with none, to Claude Code, whose setup needs no binary. With both, a
 * recorded choice from an earlier install stands, `--yes` takes both, and a
 * person at a terminal is asked, both selected, before anything is written.
 * Anyone else, an agent included, gets no host set up and the question in
 * `nextSteps`, whose answers re-run the install with the choice.
 */
export async function installHosts(
  args: InstallHostArgs,
  ctx: CommandContext,
  deps: HostDeps = {},
): Promise<HostChoice> {
  if (args.harness !== undefined) return { hosts: args.harness };
  if (args.refresh === true || args.project === true) return { hosts: ['claude'] };
  const env = deps.env ?? process.env;
  const agent = agentHost(env);
  const detected = await (deps.detect ?? detectHosts)(env);
  const found = HARNESSES.filter((h) => h === agent || detected.includes(h));
  if (found.length === 0) return { hosts: ['claude'] };
  if (found.length === 1) return { hosts: found };
  // The person's earlier choice, finished or not: a re-run retries each one.
  const recorded = ((await readHostRecord(ctx.dataDir))?.chosen ?? []).filter((h) =>
    found.includes(h),
  );
  if (recorded.length > 0) return { hosts: recorded };
  if (args.yes === true) return { hosts: found };
  const interactive =
    agent === undefined &&
    ctx.flags.json !== true &&
    (deps.isInteractive ?? (ctx.io.isTTY && Boolean(process.stdin.isTTY)));
  if (!interactive) return { hosts: [], ask: hostsStep(args) };
  const picked = await (deps.ask ?? askHosts)(found);
  if (picked === null || picked.length === 0) {
    throw new CliError('REFUSED', 'Install cancelled before anything was written.', {
      fix: 'Re-run `tenjin install` and pick at least one agent.',
    });
  }
  return { hosts: HARNESSES.filter((h) => picked.includes(h)) };
}

const HOSTS_QUESTION = 'Tenjin found Claude Code and Codex here. Set it up for which?';

/**
 * The hosts question for whoever ran the install. Nothing is set up yet, so
 * each answer re-runs this install with the choice.
 */
export function hostsStep(args: InstallHostArgs = {}): QuestionStep {
  const install = (choice: string) =>
    [
      'tenjin install',
      choice,
      ...(args.noWallet === true ? ['--no-wallet'] : []),
      ...(args.maxAutoSpend !== undefined ? [`--max-auto-spend ${args.maxAutoSpend}`] : []),
      ...(args.sessionBudget !== undefined ? [`--session-budget ${args.sessionBudget}`] : []),
    ].join(' ');
  const options: QuestionStep['options'] = [
    {
      id: 'both',
      label: 'Claude Code and Codex',
      recommended: true,
      command: install('--harness claude,codex'),
    },
    {
      id: 'claude',
      label: 'Claude Code only',
      recommended: false,
      command: install('--harness claude'),
    },
    { id: 'codex', label: 'Codex only', recommended: false, command: install('--harness codex') },
  ];
  return {
    id: 'hosts',
    question: HOSTS_QUESTION,
    options,
    next: `In this session, ask the person this question with your question tool, offering these three options in order with the first marked recommended. Nothing is set up until the answer. Run the command of the option they pick: ${options.map((o) => `"${o.label}": \`${o.command}\``).join('; ')}. Run it alone, never joined with another command, and never ask the person to run a command.`,
  };
}

/**
 * One install result over the hosts, with the questions for whoever ran it in
 * one top-level `nextSteps`: the hosts question first, then each host's own,
 * once per id.
 */
export function withSteps(
  out: CommandResult,
  hosts: readonly Harness[],
  ask?: QuestionStep,
): CommandResult {
  const data = (out.data ?? {}) as Record<string, unknown>;
  const own = (d: unknown): QuestionStep[] => {
    const steps = (d as { nextSteps?: unknown } | null)?.nextSteps;
    return Array.isArray(steps) ? (steps as QuestionStep[]) : [];
  };
  const steps = [
    ...(ask !== undefined ? [ask] : []),
    ...(hosts.length === 1 ? own(data) : hosts.flatMap((h) => own(data[h]))),
  ].filter((step, i, all) => all.findIndex((s) => s.id === step.id) === i);
  if (hosts.length === 1 && ask === undefined) return out;
  return {
    data: { ...data, nextSteps: steps },
    humanLines: [
      ...(out.humanLines ?? []),
      ...(ask !== undefined
        ? [
            'Nothing is set up until the person picks the agents.',
            `Ask the person in this session: ${ask.question}`,
            ...ask.options.map(
              (o) => `  ${o.label}${o.recommended ? ' (recommended)' : ''}: ${o.command ?? ''}`,
            ),
          ]
        : []),
    ],
  };
}

/** The hosts doctor checks and uninstall removes: the record, else Claude Code. */
export async function recordedHosts(
  args: { harness?: Harness[]; project?: boolean },
  dataDir: string,
): Promise<Harness[]> {
  if (args.harness !== undefined) return args.harness;
  if (args.project === true) return ['claude'];
  const record = await readHostRecord(dataDir);
  const hosts = HARNESSES.filter(
    (h) => record?.chosen.includes(h) === true || record?.installed.includes(h) === true,
  );
  return hosts.length === 0 ? ['claude'] : hosts;
}

/** Hosts the person chose whose setup did not finish. */
async function unfinishedHosts(dataDir: string): Promise<Harness[]> {
  const record = await readHostRecord(dataDir);
  return record === null ? [] : record.chosen.filter((h) => !record.installed.includes(h));
}

/**
 * Doctor over the hosts, where a chosen host whose setup did not finish
 * fails with the fix to finish it, before its own checks.
 */
export async function doctorEach(
  hosts: readonly Harness[],
  dataDir: string,
  run: (host: Harness) => Promise<CommandResult>,
): Promise<CommandResult> {
  const unfinished = await unfinishedHosts(dataDir);
  return checkEach(hosts, async (host) => {
    if (unfinished.includes(host)) {
      throw new CliError(
        'REFUSED',
        `${LABEL[host]} was chosen at install, but its setup did not finish.`,
        {
          fix: 'Run `tenjin install` to finish it.',
        },
      );
    }
    return run(host);
  });
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
 * Uninstall over the hosts: a host leaves the record only once its removal
 * left nothing behind. A Claude Code removal that reports the plugin `kept`,
 * or a Codex removal that failed (it throws), keeps the host recorded so a
 * later bare uninstall or doctor still finds it. A project uninstall leaves
 * the user-scope install, so it forgets nothing.
 */
export async function uninstallEach(
  hosts: readonly Harness[],
  dataDir: string,
  project: boolean,
  run: (host: Harness) => Promise<CommandResult>,
  /** A read of the host that confirms its plugin is gone; false when it cannot. */
  confirmAbsent: (host: Harness) => Promise<boolean> = async () => false,
): Promise<CommandResult> {
  const unfinished = await unfinishedHosts(dataDir);
  return runEach(hosts, async (host) => {
    let out: CommandResult;
    try {
      out = await run(host);
    } catch (err) {
      if (!unfinished.includes(host) || !(err instanceof CliError)) throw err;
      // A setup that never finished may have left nothing, or may have left the
      // plugin: the record clears only once a read confirms it is gone.
      if (await confirmAbsent(host).catch(() => false)) {
        if (!project) await forgetInstalledHost(dataDir, host);
        return {
          data: { host, cleared: true },
          humanLines: [`${LABEL[host]}: its setup never finished and nothing is left; cleared it.`],
        };
      }
      return {
        data: { host, kept: true, error: err.message },
        humanLines: [
          `${LABEL[host]}: could not remove it (${err.message}); kept on the record, so \`tenjin uninstall\` can try again.`,
        ],
      };
    }
    if (!project && !pluginKept(out.data)) await forgetInstalledHost(dataDir, host);
    return out;
  });
}

/** The Claude Code removal's `plugin.plugin: 'kept'`: the plugin is still there. */
function pluginKept(data: unknown): boolean {
  const plugin = (data as { plugin?: unknown } | null)?.plugin;
  return (
    plugin !== null &&
    typeof plugin === 'object' &&
    (plugin as { plugin?: unknown }).plugin === 'kept'
  );
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
