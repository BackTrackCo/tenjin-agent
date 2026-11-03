import { persistImproveAnswer } from '../commands/config';
import { confirmChoice } from '../lib/clack';
import type { PartialConfig } from '../lib/config';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import type { QuestionStep } from './install';

/**
 * "HELP IMPROVE ROUTING", ASKED ONCE PER MACHINE. Off until the person says
 * yes: the router then keeps the secret-masked text of the turns it sees, so
 * its offers can be graded on real work (`router.improve`).
 *
 * At a terminal it is one plain yes/no question, default No. When an agent
 * runs the install there is no terminal to ask at, so the question goes to
 * the agent, with the one command a yes runs; with no answer it stays off.
 * A machine installed before the question existed never reaches it there:
 * auto-update and `tenjin update` bring it the new build through `install
 * --refresh`, which asks nothing, and a package manager through no install at
 * all. So its first routed prompt hands the question to the agent in that
 * session instead ({@link improveSessionAsk}). Every way, the config records
 * that it was asked, so nothing asks again. A machine whose file already
 * names `router.improve` has answered it, and is not asked.
 */

/** What is kept, why and for how long; the same in both versions. */
const IMPROVE_KEPT =
  'Help improve routing? Tenjin keeps the secret-masked text of turns the router sees, including anything pasted into them, to check and improve its offers. ' +
  "It's kept until you turn this off, which deletes it.";
const IMPROVE_POLICY = `Details: ${PRODUCTION_ORIGIN}/privacy`;

/** At a terminal, where the person runs commands themselves. */
export const IMPROVE_QUESTION = `${IMPROVE_KEPT} Turn it off any time with \`tenjin config set router.improve false\`. ${IMPROVE_POLICY}`;

/**
 * Through an agent, which puts it to the person as written: no shell command
 * in front of them, as the fund question keeps its commands in the options.
 */
export const IMPROVE_AGENT_QUESTION = `${IMPROVE_KEPT} You can ask your agent to turn it off any time. ${IMPROVE_POLICY}`;

export interface ImproveDeps {
  /** The yes/no question at a terminal; defaults to the clack confirm, default No. */
  promptImprove?: (message: string) => Promise<boolean>;
}

/** Whether this machine's person still has the question to answer. */
export function improveUnasked(config: PartialConfig): boolean {
  return config.install?.improveAsked !== true && config.router?.improve === undefined;
}

/**
 * At a terminal, before anything is written: the person's answer, or
 * undefined when it is not asked here. `--yes` takes every default without a
 * question, and the default is off. Cancelling reads as No.
 */
export async function askImprove(
  config: PartialConfig,
  o: { canPrompt: boolean; yes: boolean; refresh: boolean },
  deps: ImproveDeps,
): Promise<boolean | undefined> {
  if (!o.canPrompt || o.yes || o.refresh || !improveUnasked(config)) return undefined;
  return (deps.promptImprove ?? ((message) => confirmChoice(message, false)))(IMPROVE_QUESTION);
}

/**
 * What the agent does with the answer. The agent version of the question
 * tells the person they can ask to turn it off, so the agent is given that
 * command too.
 */
function relayRules(yes: string, off: string): string {
  return (
    `it is off until they say yes. On yes, run ${yes} yourself, alone; never ask the person to run it. ` +
    `On no, or with no answer, run nothing. Do not ask it again. If they later ask you to turn it off, run \`${off}\`.`
  );
}

/**
 * The question for the agent that ran the install, recorded as asked once it
 * is handed over: a yes runs `command config set router.improve true`, and
 * anything else runs nothing. Undefined when there is nobody to ask it (no
 * agent ran this) or it was answered before. It never rides with the spend
 * question, whose answer runs the install again: it goes with the install
 * that answer runs.
 */
export async function improveStep(
  dataDir: string,
  config: PartialConfig,
  o: { asksAgent: boolean; spendPending: boolean; command: string },
): Promise<QuestionStep | undefined> {
  if (!o.asksAgent || o.spendPending || !improveUnasked(config)) return undefined;
  await persistImproveAnswer(dataDir, undefined).catch(() => undefined);
  return {
    id: 'improve',
    question: IMPROVE_AGENT_QUESTION,
    options: [
      {
        id: 'yes',
        label: 'Yes, help improve routing',
        recommended: false,
        command: `${o.command} config set router.improve true`,
      },
      { id: 'no', label: 'No', recommended: false, command: null },
    ],
    next: `${process.platform === 'win32' ? 'Use PowerShell. ' : ''}Ask this question once, as written; ${relayRules("that option's command", `${o.command} config set router.improve false`)}`,
  };
}

/**
 * The question for the agent in a session on a machine nobody has asked, for
 * the prompt leg to add beside its answer; undefined when it was asked or
 * answered before. Recorded as asked FIRST, and handed over only once that
 * write has landed: a config that cannot be written would otherwise put the
 * question on every prompt.
 */
export async function improveSessionAsk(
  dataDir: string,
  config: PartialConfig,
): Promise<string | undefined> {
  if (!improveUnasked(config)) return undefined;
  try {
    await persistImproveAnswer(dataDir, undefined);
  } catch {
    return undefined;
  }
  return (
    'ask the person one question, once, as written, at the end of your reply to this turn; ' +
    relayRules(
      '`tenjin config set router.improve true`',
      'tenjin config set router.improve false',
    ) +
    ` The question: "${IMPROVE_AGENT_QUESTION}"`
  );
}

/** The question as the install summary prints it. */
export function improveLines(step: QuestionStep): string[] {
  return [
    `  Ask the person: ${step.question}`,
    `  Yes: ${step.options[0]?.command ?? 'tenjin config set router.improve true'}`,
    '  No: run nothing; it stays off',
  ];
}
