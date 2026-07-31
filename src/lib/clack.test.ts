import { describe, it, expect } from 'vitest';
import { PassThrough, Readable, Writable } from 'node:stream';
import { confirmChoice, selectOne } from './clack';

/**
 * The EOF contract, pinned against the real @clack/prompts.
 *
 * Ctrl-D at a prompt (or any stdin reaching EOF) used to leave clack's promise
 * unsettled: the process died on an unsettled top-level await, printed nothing,
 * and left the cursor hidden. These tests drive the real library with an input
 * stream that ends, so a renderer upgrade that reintroduces the hang fails here
 * rather than in someone's terminal.
 */

/** A writable that records what the prompt drew, so cursor state is assertable. */
function sink(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  }) as Writable & { text: () => string };
  w.text = () => chunks.join('');
  return w;
}

/** Stdin that is already at EOF, the shape a detached harness leaves behind. */
const emptyInput = (): Readable => Readable.from([]);

/** Stdin that is open now and reaches EOF while the prompt is waiting. */
function closingInput(): Readable {
  const s = new PassThrough();
  setTimeout(() => s.end(), 10);
  return s;
}

/**
 * Stdin that stays open and delivers the ctrl-D BYTE, which is what a real
 * terminal sends. The prompt has stdin in raw mode by then, so 0x04 is ordinary
 * data and no stream event fires: this is the case that actually hung, and it is
 * not the same test as `closingInput`.
 */
function ctrlDInput(): Readable {
  const s = new PassThrough();
  setTimeout(() => s.write('\x04'), 10);
  return s;
}

const CHOICES = [
  { value: 'auto' as const, label: 'Auto (recommended)' },
  { value: 'review' as const, label: 'Ask me in chat first' },
];

/** Fail loudly rather than hanging the whole suite if the EOF path regresses. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`prompt did not settle within ${ms}ms`)), ms),
    ),
  ]);
}

describe('selectOne: input that ends', () => {
  it('settles as cancelled when stdin is already at EOF', async () => {
    const output = sink();
    const answer = await within(
      2000,
      selectOne({
        message: 'pick',
        choices: CHOICES,
        initialValue: 'auto',
        streams: { input: emptyInput(), output },
      }),
    );
    expect(answer).toBeNull();
  });

  it('settles as cancelled when stdin ends mid-prompt (ctrl-D)', async () => {
    const output = sink();
    const answer = await within(
      2000,
      selectOne({
        message: 'pick',
        choices: CHOICES,
        initialValue: 'auto',
        streams: { input: closingInput(), output },
      }),
    );
    expect(answer).toBeNull();
  });

  it('settles as cancelled on the ctrl-D byte, with the stream still open', async () => {
    const output = sink();
    const input = ctrlDInput();
    const answer = await within(
      2000,
      selectOne({
        message: 'pick',
        choices: CHOICES,
        initialValue: 'auto',
        streams: { input, output },
      }),
    );
    expect(answer).toBeNull();
    expect(input.readableEnded).toBe(false); // nothing ended; only a byte arrived
  });

  it('leaves the cursor shown, not hidden', async () => {
    const output = sink();
    await within(
      2000,
      selectOne({
        message: 'pick',
        choices: CHOICES,
        initialValue: 'auto',
        streams: { input: closingInput(), output },
      }),
    );
    // The prompt hides the cursor while it draws; whoever settles must show it
    // again, or the operator's terminal keeps an invisible cursor after exit.
    expect(output.text()).toContain('\x1b[?25h');
    expect(output.text().lastIndexOf('\x1b[?25h')).toBeGreaterThan(
      output.text().lastIndexOf('\x1b[?25l'),
    );
  });
});

describe('confirmChoice: input that ends', () => {
  it('settles as no when stdin is already at EOF, never as the default yes', async () => {
    const output = sink();
    const answer = await within(
      2000,
      confirmChoice('go ahead?', true, { input: emptyInput(), output }),
    );
    expect(answer).toBe(false);
  });

  it('settles as no when stdin ends mid-prompt (ctrl-D)', async () => {
    const output = sink();
    const answer = await within(
      2000,
      confirmChoice('go ahead?', true, { input: closingInput(), output }),
    );
    expect(answer).toBe(false);
  });

  it('settles as no on the ctrl-D byte, with the stream still open', async () => {
    const output = sink();
    const input = ctrlDInput();
    const answer = await within(2000, confirmChoice('go ahead?', true, { input, output }));
    expect(answer).toBe(false);
    expect(input.readableEnded).toBe(false);
  });

  it('leaves the cursor shown', async () => {
    const output = sink();
    await within(2000, confirmChoice('go ahead?', true, { input: closingInput(), output }));
    expect(output.text()).toContain('\x1b[?25h');
  });
});
