import { homedir } from 'node:os';
import type { CommandContext } from '../context';
import type { PartialConfig } from '../lib/config';
import { formatUsdDisplay } from '../lib/money';
import { paint } from '../lib/output';
import { tilde } from '../lib/paths';
import { modelConsentSchema, namedDirectories } from './model-settings';

/**
 * WHAT A PERSON IS SHOWN ABOUT DEEPSEEK SUBAGENTS, in one place: the block `tenjin config
 * subagents` and the setup receipt print, the short terms, and the row of `tenjin status`.
 * It imports nothing of the worker or the job store, so `tenjin status` and the installer
 * load it without them.
 */

/** The page the setup question and each turn-on send a person to for the full terms. */
export const SUBAGENT_DETAILS_URL =
  'https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/subagents.md';

/**
 * THE ONE SHORT TERMS TEXT, printed after `tenjin config subagents on` and after "Turn on"
 * in setup. It names every recipient the consent record names and the `~/.claude` read.
 * The full terms are the guide and the `disclosure` field of `on --json`.
 */
export const SUBAGENT_TERMS: readonly string[] = [
  'Before each offer, Tenjin and TypeSafe get the task and recent conversation. Routing costs up to $0.003 an offer, also when Claude declines it.',
  'When Claude accepts, Tenjin and DeepSeek get the task, its instructions and the worker’s tool results. Web searches, and the address of a public page the worker could not fetch, go to Exa.',
  'In ~/.claude, Claude Code loads your CLAUDE.md, skills and plugins as the worker’s instructions. The worker’s file tools can read the session transcripts, prompt history and settings there, and what they read can reach DeepSeek.',
  `Details: ${SUBAGENT_DETAILS_URL}`,
];

const OFF_HINT = 'Run `tenjin config subagents off` to turn them off.';
export const ON_HINT = 'Run `tenjin config subagents on` to turn them on.';
/** After `off`, and after "Keep off" in setup. */
export const SUBAGENTS_OFF_LINE = '○ DeepSeek subagents are off. No new jobs will start.';

/**
 * THE SCOPE IN PLAIN WORDS, the same in the status, after each `on` and in `tenjin status`:
 * every workspace, or the listed directories. A listed directory includes its subfolders.
 */
export function scopeWords(directories: readonly string[] | null, home = homedir()): string {
  if (!directories) return 'Every workspace';
  const shown = directories.map((path) => tilde(path, home)).join(', ');
  return `${shown} and ${directories.length === 1 ? 'its' : 'their'} subfolders`;
}
const usd = (atomic: bigint) => `$${formatUsdDisplay(atomic.toString())}`;

/** What a turn-on or the status shows: the scope, a change of it, and the cap in force. */
export type SubagentsShown = {
  directories: readonly string[] | null;
  /** The scope this turn-on replaced, where it narrowed or widened a saved consent. */
  was?: readonly string[] | 'every-workspace';
  perCall: bigint;
  /** The ceiling named with `--max-job`. */
  named?: bigint;
  /** Whether a daily budget is set. */
  daily: boolean;
  routerOrigin: string;
};

/** The cap in force, read from the settings: the per-call limit, or a lower named ceiling. */
function costWords({ perCall, named, daily }: SubagentsShown): string {
  const cap =
    named === undefined
      ? `Up to ${usd(perCall)} a job (your per-call limit)`
      : named < perCall
        ? `Up to ${usd(named)} a job (your --max-job)`
        : `Up to ${usd(perCall)} a job (your per-call limit; your --max-job of ${usd(named)} does not lift it)`;
  return daily ? `${cap} · your daily budget applies` : cap;
}

const ROW_LABEL = 9;
const row = (label: string, value: string) => `  ${label.padEnd(ROW_LABEL)}${value}`;

/** The scope row's words: the scope, and the one a turn-on replaced when it changed it. */
export function scopeShown({ directories, was }: SubagentsShown, home = homedir()): string {
  const before =
    was === undefined
      ? ''
      : was === 'every-workspace'
        ? ' (was every workspace)'
        : ` (was ${was.map((path) => tilde(path, home)).join(', ')} only)`;
  return scopeWords(directories, home) + before;
}

/**
 * THE ON BLOCK, laid out as `tenjin status` is: the header, the scope and cost rows, the
 * short terms after a turn-on, and how to turn it off. `tenjin config subagents`, its `on`
 * and the setup receipt after "Turn on" all print this, so there is one layout and one terms text.
 */
export function subagentsOnLines(
  ctx: CommandContext,
  shown: SubagentsShown,
  options: { terms?: boolean; notes?: readonly string[] } = {},
): string[] {
  return [
    `${paint(ctx.io, 'green', '●')} DeepSeek subagents are on`,
    '',
    row('Scope', scopeShown(shown)),
    row('Cost', costWords(shown)),
    // The router is said only when it is not Tenjin's own.
    ...(shown.routerOrigin === 'https://tenjin.sh' ? [] : [row('Router', shown.routerOrigin)]),
    ...(options.terms ? ['', ...SUBAGENT_TERMS] : []),
    ...(options.notes?.length ? ['', ...options.notes] : []),
    '',
    OFF_HINT,
  ];
}

/** The `Subagents` row of `tenjin status`: on with its scope, or off. */
export function subagentsStatusValue(config: PartialConfig): string {
  if (config.router?.subagents !== true) return 'Off';
  const consent = modelConsentSchema.safeParse(config.router?.subagentConsent);
  if (!consent.success) return 'On, but no consent is saved';
  const directories = namedDirectories(consent.data);
  return `On · ${
    !directories
      ? 'every workspace'
      : directories.length === 1
        ? scopeWords(directories)
        : `${directories.length} directories`
  }`;
}
