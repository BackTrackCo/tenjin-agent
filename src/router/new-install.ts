import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import type { CommandContext, CommandResult } from '../context';
import { persist } from '../commands/config';
import { loadRawConfig, resolveSettings, type PartialConfig } from '../lib/config';
import { selectOne } from '../lib/clack';
import { CliError } from '../lib/errors';
import { hasCode } from '../lib/errno';
import type { QuestionStep } from './install';
import { nativeWorkspaceModelConsent } from './model-settings';

export type InstallSubagentChoice = 'on' | 'off';

export const DEEPSEEK_INSTALL_TERMS =
  'Enabling eligible DeepSeek subagents follows the host’s qualified native workspace, with parent accept or veto and a $1 job limit. Tenjin and TypeSafe receive assignments and bounded parent context. After acceptance, Tenjin and DeepSeek receive assignments, instructions and tool results. A worker can read your ~/.claude folder, including session transcripts. Exa receives worker web search queries and URLs that the worker could not fetch. Inference adds 5%, routing costs 15% of expected inference, up to $0.003 per offer, and Exa searches cost $0.004 each. Your spend limits apply.';

const SUBAGENT_QUESTION = `Turn on DeepSeek subagents? ${DEEPSEEK_INSTALL_TERMS}`;
const SUBAGENT_OPTIONS = [
  { value: 'off', label: 'Keep off' },
  { value: 'on', label: 'Turn on' },
] as const;

export type NewInstallSession = {
  readonly dataDir: string;
  readonly absent: boolean;
  claimId?: string;
  continueWith?: string;
  completed: boolean[];
  disqualified?: boolean;
};

/** Capture before runtime, wallet, identity or config writes. Existing empty profiles count as existing. */
export async function captureNewInstall(dataDir: string): Promise<NewInstallSession> {
  let absent = false;
  try {
    await lstat(dataDir);
  } catch (error) {
    absent = hasCode(error, 'ENOENT');
  }
  return { dataDir, absent, completed: [] };
}

function origin(config: PartialConfig, ctx: CommandContext): string | undefined {
  try {
    return new URL(
      resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env }).baseUrl
        .value,
    ).origin;
  } catch {
    return undefined;
  }
}

function blocked(config: PartialConfig): boolean {
  const router = config.router;
  return (
    router?.enabled === false ||
    (router !== undefined &&
      (Object.hasOwn(router, 'subagents') || Object.hasOwn(router, 'subagentConsent')))
  );
}

function withoutClaim(config: PartialConfig): PartialConfig {
  const install = { ...config.install };
  delete install.pendingDeepSeekSetup;
  return { ...config, install };
}

/** A durable unfinished-install claim grants no sharing or spending authority. */
export async function reserveNewInstall(
  session: NewInstallSession,
  ctx: CommandContext,
  eligible = true,
): Promise<void> {
  session.disqualified ||= !eligible;
  if (session.disqualified) {
    // A preexisting host surface disqualifies the entire shared setup. Do not
    // leave another host's claim available to enable it on a later invocation.
    if (session.claimId || !session.absent) {
      await persist(session.dataDir, (config) =>
        config.install?.pendingDeepSeekSetup ? withoutClaim(config) : config,
      );
    }
    session.claimId = undefined;
    return;
  }
  let created = false;
  if (session.absent) {
    try {
      // Exactly one competing setup may claim an absent profile, even before config exists.
      await mkdir(session.dataDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  await persist(session.dataDir, (config) => {
    const pending = config.install?.pendingDeepSeekSetup;
    const routerOrigin = origin(config, ctx);
    if (blocked(config) || !routerOrigin || (pending && pending.routerOrigin !== routerOrigin)) {
      session.claimId = undefined;
      return pending ? withoutClaim(config) : config;
    }
    if (pending) {
      session.claimId = pending.id;
      return config;
    }
    // Another config writer or an older profile always wins over a fresh-install choice.
    if (!created || Object.keys(config).length !== 0) return config;
    session.claimId = randomUUID();
    return {
      ...config,
      install: {
        ...config.install,
        pendingDeepSeekSetup: { version: 1, id: session.claimId, routerOrigin },
      },
    };
  });
}

/** Where an existing profile changes the setting `--subagents` could not change. */
const CHOICE_FIX: Record<InstallSubagentChoice, string> = {
  on: 'Run `tenjin config subagents on --repository <path> --max-job <USD>` to turn DeepSeek subagents on for a directory.',
  off: 'Run `tenjin config subagents off` to turn DeepSeek subagents off.',
};

/**
 * `--subagents` answers the question of a fresh setup and nothing else. A profile that was
 * already here, with no unfinished setup for this router, is refused before anything is
 * written: the flag would change nothing there, and said nothing.
 */
export async function requireOpenChoice(
  session: NewInstallSession,
  ctx: CommandContext,
  choice: InstallSubagentChoice,
): Promise<void> {
  if (session.absent) return;
  const config = await loadRawConfig(session.dataDir);
  const pending = config.install?.pendingDeepSeekSetup;
  if (pending && !blocked(config) && origin(config, ctx) === pending.routerOrigin) return;
  throw new CliError(
    'USAGE',
    `--subagents ${choice} answers the question of a fresh setup only, and this profile already exists. Nothing was changed.`,
    { fix: CHOICE_FIX[choice] },
  );
}

/** A choice this run lost the right to apply (another host or writer was here first), said on its receipt. */
function choiceNotApplied(result: CommandResult, choice: InstallSubagentChoice): CommandResult {
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      subagents: { applied: false, fix: CHOICE_FIX[choice] },
    },
    humanLines: [
      ...(result.humanLines ?? []),
      `--subagents ${choice} was not applied: this was not a fresh setup. ${CHOICE_FIX[choice]}`,
    ],
  };
}

function hostsCompleted(session: NewInstallSession): boolean {
  return session.completed.length > 0 && session.completed.every(Boolean);
}

function matchesClaim(session: NewInstallSession, config: PartialConfig, ctx: CommandContext) {
  const pending = config.install?.pendingDeepSeekSetup;
  return (
    pending !== undefined &&
    pending.id === session.claimId &&
    !blocked(config) &&
    origin(config, ctx) === pending.routerOrigin
  );
}

/** Apply one explicit choice after all hosts are installed, under the config lock. */
export async function completeNewInstall(
  session: NewInstallSession,
  ctx: CommandContext,
  choice?: InstallSubagentChoice,
): Promise<InstallSubagentChoice | undefined> {
  if (!session.claimId || !hostsCompleted(session)) return undefined;
  let applied: InstallSubagentChoice | undefined;
  await persist(session.dataDir, (config) => {
    const pending = config.install?.pendingDeepSeekSetup;
    if (!pending || pending.id !== session.claimId) return config;
    const next = withoutClaim(config);
    if (!matchesClaim(session, config, ctx)) return next;
    if (choice === undefined) return config;
    applied = choice;
    return {
      ...next,
      router: {
        ...config.router,
        subagents: choice === 'on',
        ...(choice === 'on'
          ? { subagentConsent: nativeWorkspaceModelConsent({ routerOrigin: pending.routerOrigin }) }
          : {}),
      },
    };
  });
  return applied;
}

type InstallReceipt = {
  hosts?: string[];
  next?: string;
  nextSteps?: QuestionStep[];
  [key: string]: unknown;
};

function addSubagentQuestion(result: CommandResult, command: string): CommandResult {
  const data = result.data as InstallReceipt;
  const [first] = data.hosts ?? [];
  const hostReceipts = data.hosts ? data.hosts.map((host) => data[host] as InstallReceipt) : [data];
  // The spending answer reruns install. Offer the next choice on that result.
  if (hostReceipts.some(({ nextSteps }) => nextSteps?.some(({ id }) => id === 'spend')))
    return result;
  const target = hostReceipts[0] ?? data;
  const step: QuestionStep = {
    id: 'subagents',
    question: SUBAGENT_QUESTION,
    options: SUBAGENT_OPTIONS.map(({ value, label }) => ({
      id: value,
      label,
      recommended: value === 'off',
      command: `${command} --subagents ${value}`,
    })),
    next: `${process.platform === 'win32' ? 'Use PowerShell. ' : ''}Ask the person once with these two choices. Run the selected command only after they answer, then read its result and continue setup. Keep subagents off if they do not answer.`,
  };
  const next = target.next ?? 'continue setup';
  const asked = {
    ...target,
    next: next.toLowerCase().startsWith('follow the instructions in nextsteps')
      ? next
      : `Follow the instructions in nextSteps, then ${next}`,
    nextSteps: [step, ...(target.nextSteps ?? [])],
  };
  return { ...result, data: first === undefined ? asked : { ...data, [first]: asked } };
}

export async function finishNewInstall(
  result: CommandResult,
  session: NewInstallSession,
  ctx: CommandContext,
  options: {
    choice?: InstallSubagentChoice;
    yes?: boolean;
    harness?: 'claude' | 'codex';
    isInteractive?: boolean;
    promptSubagents?: () => Promise<InstallSubagentChoice | null>;
  } = {},
): Promise<CommandResult> {
  if (!session.claimId || !hostsCompleted(session))
    return options.choice !== undefined && !session.claimId
      ? choiceNotApplied(result, options.choice)
      : result;
  const interactive =
    ctx.flags.json !== true &&
    (options.isInteractive ?? (ctx.io.isTTY && Boolean(process.stdin.isTTY)));
  const pending =
    options.choice === undefined &&
    matchesClaim(session, await loadRawConfig(session.dataDir), ctx);
  const answer =
    pending && interactive && !options.yes
      ? ((await (options.promptSubagents ?? askSubagents)()) ?? 'off')
      : options.choice;
  const applied = await completeNewInstall(session, ctx, answer);
  if (applied === undefined) {
    if (options.choice !== undefined) return choiceNotApplied(result, options.choice);
    if (!pending || interactive || !session.continueWith) return result;
    const harness = options.harness ? ` --harness ${options.harness}` : '';
    return addSubagentQuestion(result, session.continueWith + harness);
  }
  const enabled = applied === 'on';
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      subagents: enabled
        ? { enabled, scope: 'native-workspace', maxJobAtomic: '1000000' }
        : { enabled },
    },
    humanLines: [
      ...(result.humanLines ?? []),
      enabled
        ? 'DeepSeek subagent routing is enabled with parent veto and a $1 job limit. Turn it off with `tenjin config subagents off`.'
        : 'DeepSeek subagent routing is off.',
    ],
  };
}

function askSubagents() {
  return selectOne({
    message: SUBAGENT_QUESTION,
    choices: [...SUBAGENT_OPTIONS],
    initialValue: 'off',
  });
}
