import { persistImproveAnswer } from '../commands/config';
import { confirmChoice } from '../lib/clack';
import type { PartialConfig } from '../lib/config';
import type { QuestionStep } from './install';

/**
 * "HELP IMPROVE ROUTING", ASKED ONCE PER MACHINE AT INSTALL. Off until the
 * person says yes: the router then keeps the secret-masked text of the turns
 * it sees, so its offers can be graded on real work (`router.improve`).
 *
 * At a terminal it is one plain yes/no question, default No. When an agent
 * runs the install there is no terminal to ask at, so the question goes to
 * the agent, with the one command a yes runs; with no answer it stays off.
 * Either way the config records that it was asked, so a reinstall or an
 * update never asks again. A machine whose file already names
 * `router.improve` has answered it, and is not asked at all.
 */

export const IMPROVE_QUESTION =
  'Help improve routing? Tenjin keeps the secret-masked text of turns the router sees so we can grade its offers. ' +
  'You can turn this off any time with `tenjin config set router.improve false`.';

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
    question: IMPROVE_QUESTION,
    options: [
      {
        id: 'yes',
        label: 'Yes, help improve routing',
        recommended: false,
        command: `${o.command} config set router.improve true`,
      },
      { id: 'no', label: 'No', recommended: false, command: null },
    ],
    next: `${process.platform === 'win32' ? 'Use PowerShell. ' : ''}Ask this question once, as written; it is off until they say yes. On yes, run that option's command yourself, alone; never ask the person to run it. On no, or with no answer, run nothing. Do not ask it again.`,
  };
}

/** The question as the install summary prints it. */
export function improveLines(step: QuestionStep): string[] {
  return [
    `  Ask the person: ${step.question}`,
    `  Yes: ${step.options[0]?.command ?? 'tenjin config set router.improve true'}`,
    '  No: run nothing; it stays off',
  ];
}
