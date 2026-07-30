import { createInterface } from 'node:readline';

export interface PromptYesNoOptions {
  /** What an EMPTY answer means; the closing of stdin (ctrl-D) is always false. */
  defaultYes?: boolean;
  /** Injectable streams for tests; label/echo go to stderr, never stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * The one y/n reader every confirm gate shares (buy, send, install). "y"/"yes"
 * (any case) is true, an empty answer follows `defaultYes` (explicit at each
 * call site), anything else is false, and stdin closing mid-prompt resolves
 * false rather than hanging. The prompt writes to stderr so stdout stays a
 * single JSON envelope.
 */
export function promptYesNo(prompt: string, opts: PromptYesNoOptions = {}): Promise<boolean> {
  const { defaultYes = false, input = process.stdin, output = process.stderr } = opts;
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once('close', () => settle(false));
    rl.question(prompt, (answer) => {
      const a = answer.trim().toLowerCase();
      settle(a === '' ? defaultYes : a === 'y' || a === 'yes');
    });
  });
}
