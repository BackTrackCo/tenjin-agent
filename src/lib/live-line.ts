import { style, type StyleFormat } from './output';

/**
 * ONE STATUS LINE THAT REWRITES ITSELF IN PLACE, for a wait a person watches
 * (`tenjin fund`, `tenjin balance --wait`). On a terminal the current state
 * spins with braille frames every 80 ms and is replaced by the next; a state
 * that is done is printed as a `✓` line that stays. Anywhere else (stderr
 * redirected to a file) each new state is one plain `…` line, written once,
 * so a log reads as the same story without a frame per tick.
 *
 * Everything goes to the stream it is given (stderr): stdout keeps the
 * command's own result, and nothing here ever throws.
 */

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const FRAME_MS = 80;
/** Where a `✓` line's detail starts, so amounts line up under each other. */
const DETAIL_COLUMN = 26;
const CLEAR_LINE = '\r\x1b[2K';

export interface LiveLine {
  /** The state now in progress, with an optional quiet aside (the link's time left). */
  spin(text: string, aside?: string): void;
  /** A finished state, kept on screen: `✓ text   detail`. */
  ok(text: string, detail?: string): void;
  /** A state that needs a word but is not a failure of this command: `! text`. */
  warn(text: string): void;
  /** Any other line, kept on screen. */
  line(text: string): void;
  /** Clear the spinning line, if any. Safe to call twice. */
  stop(): void;
}

export interface LiveLineOptions {
  /** Draw frames in place. Defaults to the stream's own `isTTY`. */
  tty?: boolean;
  /** Test seams for the frame timer. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function liveLine(stream: NodeJS.WritableStream, opts: LiveLineOptions = {}): LiveLine {
  const tty = opts.tty ?? (stream as { isTTY?: unknown }).isTTY === true;
  const every = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms).unref());
  const cancel = opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const paint = (format: StyleFormat, text: string) => style(format, text, stream);
  const write = (text: string) => {
    try {
      stream.write(text);
    } catch {
      // A status line that cannot be drawn changes nothing about the wait.
    }
  };

  let timer: unknown;
  let frame = 0;
  let current: { text: string; aside?: string } | undefined;
  let lastPlain: string | undefined;

  const draw = () => {
    if (current === undefined) return;
    const glyph = paint('blue', FRAMES[frame % FRAMES.length]!);
    const aside = current.aside !== undefined ? `  ${paint('dim', current.aside)}` : '';
    write(`${CLEAR_LINE}  ${glyph} ${current.text}${aside}`);
    frame++;
  };
  const clear = () => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    if (tty && current !== undefined) write(CLEAR_LINE);
    current = undefined;
  };
  const keep = (text: string) => {
    clear();
    write(`${text}\n`);
  };

  return {
    spin(text, aside) {
      if (!tty) {
        if (lastPlain !== text) write(`  … ${text}${aside !== undefined ? `  ${aside}` : ''}\n`);
        lastPlain = text;
        return;
      }
      current = { text, ...(aside !== undefined ? { aside } : {}) };
      if (timer === undefined) timer = every(draw, FRAME_MS);
      draw();
    },
    ok(text, detail) {
      lastPlain = undefined;
      const pad = ' '.repeat(Math.max(2, DETAIL_COLUMN - text.length));
      keep(`  ${paint('green', '✓')} ${text}${detail !== undefined ? `${pad}${detail}` : ''}`);
    },
    warn(text) {
      lastPlain = undefined;
      keep(`  ${paint('yellow', '!')} ${text}`);
    },
    line(text) {
      lastPlain = undefined;
      keep(text);
    },
    stop: clear,
  };
}
