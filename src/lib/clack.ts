import type { Readable, Writable } from 'node:stream';

/**
 * The pretty-prompt renderer behind the install walkthrough's seams.
 *
 * @clack/prompts is a devDependency BUNDLED by tsup (published `dependencies`
 * stays `{}`), and every entry point here is behind a dynamic `import()` so it
 * lands in its own split chunk: a `search` or `doctor` run never parses it.
 *
 * Nothing in this module is reachable from a machine run. Commands call it only
 * on the real interactive path (a TTY on both stdout and stdin, no `--json`),
 * and always through an injectable seam, so unit tests supply answers directly
 * and never touch clack or a terminal.
 *
 * Prompts render on STDERR, like every other prompt in this CLI: stdout carries
 * the human walkthrough (or a single JSON envelope) and must not be interleaved
 * with prompt chrome.
 */

/** Cancel (ctrl-C, escape) is not an answer. Callers map `null` to their own default. */
export type Cancelled = null;

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
  /** The one line of consequence shown beside the label. */
  hint?: string;
}

/** Streams a prompt reads and draws on. Injected by tests; defaults to the real ones. */
interface PromptStreams {
  input?: Readable;
  output?: Writable;
}

/** DECTCUM show-cursor. Written on the EOF path in case the prompt did not get to. */
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Settle a prompt when its input goes away instead of hanging forever.
 *
 * Ctrl-D at a clack prompt leaves its promise unsettled: no resolve, no reject,
 * no cancel symbol. The process then dies on an unsettled top-level await with
 * exit 13, nothing printed, and the cursor still hidden. The readline seam this
 * replaced handled it on purpose ("ctrl-D mid-prompt reads as the default"), and
 * that behavior has to survive the renderer swap.
 *
 * "Input goes away" is two different events, and only covering one of them was
 * the original bug:
 *
 *  - The STREAM ends. A pipe closes, a harness detaches, stdin was already at
 *    EOF. Caught via `end` / `close`.
 *  - The ctrl-D BYTE (0x04) arrives with the stream still open. This is what a
 *    real terminal sends, and it is the common case. A prompt puts stdin in raw
 *    mode, where 0x04 is ordinary data rather than EOF, so no stream event ever
 *    fires; clack has no binding for it and simply keeps waiting. Caught via the
 *    `keypress` decoder readline installs, which is a read-only view of the same
 *    bytes: listening there takes nothing away from the prompt, where a `data`
 *    listener would risk flipping the stream to flowing before clack reads it.
 *
 * Two mechanisms settle it, because one of them is advisory. The AbortSignal is
 * clack's own teardown: it flips the prompt to `cancel`, which restores the
 * cursor and raw mode and resolves with the cancel symbol. The race is the
 * guarantee, for a prompt that is not yet listening or never settles anyway; on
 * that path we restore the cursor ourselves, since no prompt did.
 */
function withInputEnd<T>(
  streams: Required<PromptStreams>,
  onEnd: T,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let settleEnd: (() => void) | undefined;
  const ended = new Promise<T>((resolve) => {
    settleEnd = () => {
      streams.output.write(SHOW_CURSOR);
      resolve(onEnd);
    };
  });

  const end = (): void => {
    controller.abort();
    settleEnd?.();
  };
  const onKeypress = (_text: string | undefined, key?: { name?: string; ctrl?: boolean }): void => {
    if (key?.ctrl === true && key.name === 'd') end();
  };

  streams.input.on('keypress', onKeypress);
  // A stream that finished before we got here never emits `end` again, so ask.
  if (streams.input.readableEnded) {
    queueMicrotask(end);
  } else {
    streams.input.once('end', end);
    streams.input.once('close', end);
  }

  return Promise.race([run(controller.signal), ended]).finally(() => {
    streams.input.off('keypress', onKeypress);
    streams.input.off('end', end);
    streams.input.off('close', end);
  });
}

function resolveStreams(streams: PromptStreams): Required<PromptStreams> {
  return { input: streams.input ?? process.stdin, output: streams.output ?? process.stderr };
}

/**
 * A single-choice list. Returns the chosen value, or `null` when the operator
 * cancelled or the input ended, both of which callers treat as "leave everything
 * as it was".
 */
export async function selectOne<T extends string>(opts: {
  message: string;
  choices: readonly SelectChoice<T>[];
  initialValue: T;
  streams?: PromptStreams;
}): Promise<T | Cancelled> {
  const { select, isCancel } = await import('@clack/prompts');
  const streams = resolveStreams(opts.streams ?? {});
  return withInputEnd<T | Cancelled>(streams, null, async (signal) => {
    // Instantiated at `string`, not at `T`: clack's `Option<Value>` is a conditional
    // type that a generic `T extends string` cannot resolve. The values come from
    // this call's own choices, so narrowing the answer back is sound.
    const answer = await select<string>({
      message: opts.message,
      options: opts.choices.map((c) => ({
        value: c.value as string,
        label: c.label,
        ...(c.hint !== undefined ? { hint: c.hint } : {}),
      })),
      initialValue: opts.initialValue,
      input: streams.input,
      output: streams.output,
      signal,
    });
    return isCancel(answer) ? null : (answer as T);
  });
}

/** A yes/no confirm. Cancelling, or an input that ends, reads as no. */
export async function confirmChoice(
  message: string,
  initialValue = true,
  streams: PromptStreams = {},
): Promise<boolean> {
  const { confirm, isCancel } = await import('@clack/prompts');
  const resolved = resolveStreams(streams);
  return withInputEnd<boolean>(resolved, false, async (signal) => {
    const answer = await confirm({
      message,
      initialValue,
      input: resolved.input,
      output: resolved.output,
      signal,
    });
    return isCancel(answer) ? false : answer;
  });
}

/** Open the walkthrough's prompt sequence with a title bar. */
export async function intro(message: string): Promise<void> {
  const clack = await import('@clack/prompts');
  clack.intro(message, { output: process.stderr });
}

/** Close it, so the last prompt is not left dangling above plain stdout lines. */
export async function outro(message: string): Promise<void> {
  const clack = await import('@clack/prompts');
  clack.outro(message, { output: process.stderr });
}
