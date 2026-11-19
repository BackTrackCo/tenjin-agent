import { lstat, mkdir } from 'node:fs/promises';
import type { CommandContext, CommandResult } from '../context';
import { persist } from '../commands/config';
import {
  SUBAGENT_DETAILS_URL,
  SUBAGENT_TERMS,
  SUBAGENTS_KEPT_OFF_LINES,
  subagentsOnLines,
} from './subagents-shown';
import { loadRawConfig, resolveSettings, type PartialConfig } from '../lib/config';
import { selectOne } from '../lib/clack';
import { hasCode } from '../lib/errno';
import type { QuestionStep } from './install';
import { MODEL_MINIMUM_CALL_ATOMIC, usdOfAtomic } from './model-limits';
import {
  modelConsent,
  modelConsentSchema,
  namedDirectories,
  perCallLimitAtomic,
} from './model-settings';

export type InstallSubagentChoice = 'on' | 'off';

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
              // The question's own consent: every session's workspace, no directory.
              subagentConsent: modelConsent({ routerOrigin }),
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
  const consent = modelConsentSchema.safeParse(config.router?.subagentConsent).data;
  const named = consent?.maxJobAtomic === undefined ? undefined : BigInt(consent.maxJobAtomic);
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      subagents:
        saved && enabled
          ? { enabled, jobCapAtomic: perCall.toString(), terms: SUBAGENT_TERMS.join('\n') }
          : { enabled, ...(saved ? {} : { changed: false }) },
    },
    // The same block `tenjin config subagents on` prints. Its short terms follow the one
    // answer they inform: the question links to the guide, and nothing repeats after
    // "Keep off" or over an answer saved earlier.
    humanLines: [
      ...(result.humanLines ?? []),
      ...(enabled
        ? [
            '',
            ...subagentsOnLines(
              ctx,
              {
                directories: namedDirectories(consent),
                perCall,
                ...(named === undefined ? {} : { named }),
                daily:
                  resolveSettings({ config, flags: {}, env: process.env }).sessionBudget.value !==
                  'none',
                routerOrigin: origin(config, ctx) ?? 'https://tenjin.sh',
              },
              {
                terms: saved,
                notes:
                  saved && perCall <= MODEL_MINIMUM_CALL_ATOMIC
                    ? [
                        `No job is offered while that limit is not above the ${usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)} one model call needs before its routing fee. Raise it with \`tenjin config set maxAutoSpend <usd>\`.`,
                      ]
                    : [],
              },
            ),
          ]
        : ['', ...SUBAGENTS_KEPT_OFF_LINES]),
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
