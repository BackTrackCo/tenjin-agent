import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptYesNo } from './prompt';

function run(answer: string | null, defaultYes = false): Promise<boolean> {
  const input = new PassThrough();
  const output = new PassThrough();
  const result = promptYesNo('proceed? ', { defaultYes, input, output });
  if (answer === null) {
    input.end(); // stdin closes mid-prompt (ctrl-D with nothing typed)
  } else {
    input.write(`${answer}\n`);
  }
  return result;
}

describe('promptYesNo', () => {
  it.each([
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['YES', true],
    ['  y  ', true],
    ['n', false],
    ['no', false],
    ['anything else', false],
  ])('answer %j resolves %s', async (answer, expected) => {
    await expect(run(answer)).resolves.toBe(expected);
  });

  it('an empty answer follows the call site default', async () => {
    await expect(run('')).resolves.toBe(false); // buy/send: default-no
    await expect(run('', true)).resolves.toBe(true); // install: default-yes
  });

  it('a closing stream declines, even under default-yes, and never hangs', async () => {
    await expect(run(null)).resolves.toBe(false);
    await expect(run(null, true)).resolves.toBe(false);
  });

  it('writes the prompt to the given output stream, never stdout', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = promptYesNo('sure? ', { input, output });
    input.write('y\n');
    await pending;
    expect(String(output.read() ?? '')).toContain('sure? ');
  });
});
