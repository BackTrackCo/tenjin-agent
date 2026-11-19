import { lstat, mkdir } from 'node:fs/promises';
import type { CommandContext, CommandResult } from '../context';
import { persist } from '../commands/config';
import { loadRawConfig, resolveSettings, type PartialConfig } from '../lib/config';
import { selectOne } from '../lib/clack';
import { hasCode } from '../lib/errno';
import { formatUsdDisplay } from '../lib/money';
import { paint } from '../lib/output';
import type { QuestionStep } from './install';
import { MODEL_MINIMUM_JOB_ATOMIC, usdOfAtomic } from './model-limits';
import { modelConsent, perCallLimitAtomic } from './model-settings';

export type InstallSubagentChoice = 'on' | 'off';

/** Said once, to a person who has just turned subagents on: who receives what, and the fees. */
export const DEEPSEEK_INSTALL_TERMS =
  'Enabling eligible DeepSeek subagents follows the host’s qualified native workspace, with parent accept or veto. Each job costs up to your per-call spend limit. Tenjin and TypeSafe receive assignments and bounded parent context. After acceptance, Tenjin and DeepSeek receive assignments, instructions and tool results. A worker can read your ~/.claude folder, including session transcripts. Exa receives worker web search queries and URLs that the worker could not fetch. Inference adds 5%, routing costs 15% of expected inference, up to $0.003 per offer, Exa searches cost $0.004 each and a page read through Exa $0.001. Your spend limits apply.';

/** The page the question sends a person to for the recipients, the reads, the fees and the cap. */
export const SUBAGENT_DETAILS_URL =
  'https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/subagents.md';

/** The whole fresh-setup question, in a terminal and through an agent: its wording changes here alone. */
export const SUBAGENT_QUESTION = [
  'Use a cheap model for eligible subagent jobs?',
  'Claude accepts or declines each offer. DeepSeek sees accepted work and tool results.',
  `Each job costs up to your per-call spend limit. Details: ${SUBAGENT_DETAILS_URL}`,
].join('\n');
const SUBAGENT_OPTIONS = [
  { value: 'off', label: 'Keep off' },
  { value: 'on', label: 'Turn on' },
] as const;

export type NewInstallSession = {
  readonly dataDir: string;
  readonly absent: boolean;
  /** This run holds the fresh-setup marker, so it may ask the question. */
  fresh?: boolean;
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

/** Whether the person has answered: on or off, by the question, the flag or the config command. */
const answered = (config: PartialConfig) =>
  config.router !== undefined && Object.hasOwn(config.router, 'subagents');

function withoutMarker(config: PartialConfig): PartialConfig {
  const install = { ...config.install };
  delete install.freshSetup;
  return { ...config, install };
}

/**
 * Marks a profile this run created as a fresh setup. The marker is on disk because the
 * question spans the rerun that answers the spending question. It grants no sharing or
 * spending authority: it only says the question is still to be asked.
 */
export async function reserveNewInstall(
  session: NewInstallSession,
  eligible = true,
): Promise<void> {
  session.disqualified ||= !eligible;
  if (session.disqualified) {
    // A preexisting host surface makes this no fresh setup, for the other host of the run too.
    if (session.fresh || !session.absent)
      await persist(session.dataDir, (config) =>
        config.install?.freshSetup ? withoutMarker(config) : config,
      );
    session.fresh = false;
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
    if (config.install?.freshSetup) {
      session.fresh = !answered(config) && config.router?.enabled !== false;
      return session.fresh ? config : withoutMarker(config);
    }
    // Another config writer or an older profile always wins over a fresh-install question.
    session.fresh = created && Object.keys(config).length === 0;
    return session.fresh ? { ...config, install: { ...config.install, freshSetup: true } } : config;
  });
}

function hostsCompleted(session: NewInstallSession): boolean {
  return session.completed.length > 0 && session.completed.every(Boolean);
}

/**
 * Saves the person's answer, under the config lock, where none is saved yet: by the
 * question or by `--subagents`, on a fresh profile or an existing one. `on` writes the same
 * consent `tenjin config subagents on` writes. An answer already saved is never replaced
 * here; the config command changes it. Returns whether this call saved the answer.
 */
export async function saveSubagentChoice(
  dataDir: string,
  ctx: CommandContext,
  choice: InstallSubagentChoice,
): Promise<boolean> {
  let saved = false;
  await persist(dataDir, (config) => {
    saved = false;
    if (answered(config)) return config.install?.freshSetup ? withoutMarker(config) : config;
    const routerOrigin = origin(config, ctx);
    if (choice === 'on' && !routerOrigin) return config;
    saved = true;
    return {
      ...withoutMarker(config),
      router: {
        ...config.router,
        subagents: choice === 'on',
        ...(choice === 'on' && routerOrigin
          ? {
              subagentConsent: modelConsent({
                routerOrigin,
                prior: config.router?.subagentConsent,
              }),
            }
          : {}),
      },
    };
  });
  return saved;
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
  // A failed or unfinished host setup saves no answer and asks nothing.
  if (!hostsCompleted(session)) return result;
  let answer = options.choice;
  if (answer === undefined) {
    // No flag: the question, on a fresh setup, asked once.
    if (!session.fresh) return result;
    const config = await loadRawConfig(session.dataDir);
    if (!config.install?.freshSetup || answered(config)) return result;
    const interactive =
      ctx.flags.json !== true &&
      (options.isInteractive ?? (ctx.io.isTTY && Boolean(process.stdin.isTTY)));
    if (!interactive) {
      if (!session.continueWith) return result;
      const harness = options.harness ? ` --harness ${options.harness}` : '';
      return addSubagentQuestion(result, session.continueWith + harness);
    }
    if (options.yes) return result;
    answer = (await (options.promptSubagents ?? askSubagents)()) ?? 'off';
  }
  const saved = await saveSubagentChoice(session.dataDir, ctx, answer);
  const config = await loadRawConfig(session.dataDir);
  const enabled = config.router?.subagents === true;
  // The cap is the per-call limit at each offer. What it is now is said with the answer.
  const perCall = perCallLimitAtomic(config);
  // An answer saved earlier stands: the flag changed nothing, and the receipt says so.
  const stands =
    !saved && enabled !== (answer === 'on')
      ? [
          `That was already saved, so --subagents ${answer} changed nothing. Change it with \`tenjin config subagents ${answer}\`.`,
        ]
      : [];
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      subagents:
        saved && enabled
          ? { enabled, jobCapAtomic: perCall.toString(), terms: DEEPSEEK_INSTALL_TERMS }
          : { enabled, ...(saved ? {} : { changed: false }) },
    },
    // The terms follow the one answer they inform. The question links to them, and the
    // receipt's disclosure does not repeat them after either answer.
    humanLines: [
      ...(result.humanLines ?? []),
      ...(enabled
        ? [
            `DeepSeek subagent routing is enabled with parent veto. Each job costs up to your per-call spend limit, $${formatUsdDisplay(perCall.toString())} now. Turn it off with \`tenjin config subagents off\`.`,
            ...(saved && perCall < MODEL_MINIMUM_JOB_ATOMIC
              ? [
                  `No job is offered while that limit is under the ${usdOfAtomic(MODEL_MINIMUM_JOB_ATOMIC)} one model call and its routing fee need. Raise it with \`tenjin config set maxAutoSpend <usd>\`.`,
                ]
              : []),
            ...(saved ? [paint(ctx.io, 'dim', DEEPSEEK_INSTALL_TERMS)] : []),
          ]
        : ['DeepSeek subagent routing is off.']),
      ...stands,
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
