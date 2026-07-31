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

/**
 * A single-choice list. Returns the chosen value, or `null` when the operator
 * cancelled, which callers treat as "leave everything as it was".
 */
export async function selectOne<T extends string>(opts: {
  message: string;
  choices: readonly SelectChoice<T>[];
  initialValue: T;
}): Promise<T | Cancelled> {
  const { select, isCancel } = await import('@clack/prompts');
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
    output: process.stderr,
  });
  return isCancel(answer) ? null : (answer as T);
}

/** A yes/no confirm. Cancelling reads as no, never as the default. */
export async function confirmChoice(message: string, initialValue = true): Promise<boolean> {
  const { confirm, isCancel } = await import('@clack/prompts');
  const answer = await confirm({ message, initialValue, output: process.stderr });
  return isCancel(answer) ? false : answer;
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
