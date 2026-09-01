import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';

import { PUBLISH_STDIN_MAX_BYTES, readMarkdownStdin } from './stdin';

const asInput = (stream: NodeJS.ReadableStream) => ({ stream, isTTY: false });

describe('readMarkdownStdin', () => {
  it('reads a complete document', async () => {
    await expect(readMarkdownStdin(asInput(Readable.from(['# Title\n', 'body\n'])))).resolves.toBe(
      '# Title\nbody\n',
    );
  });

  it('refuses an empty stream at the source edge', async () => {
    await expect(readMarkdownStdin(asInput(Readable.from([])))).rejects.toThrow(
      /No Markdown received on stdin/,
    );
  });

  it('refuses whitespace, which /dev/null-shaped input produces', async () => {
    await expect(readMarkdownStdin(asInput(Readable.from(['   \n\t'])))).rejects.toThrow(
      /No Markdown received on stdin/,
    );
  });

  /**
   * The bound has to interrupt the READ, not judge the result. A post-hoc length
   * check would already have taken every byte into memory, which is the whole
   * cost being avoided: this runs before the consent, scan and wallet gates.
   * Counting what the generator actually yielded is what proves it stopped, so
   * an infinite source is the honest fixture — it cannot terminate on its own.
   */
  it('stops reading at the cap instead of buffering the whole stream', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'a');
    let yielded = 0;
    const endless = Readable.from(
      (function* () {
        while (true) {
          yielded += 1;
          yield chunk;
        }
      })(),
    );

    await expect(readMarkdownStdin(asInput(endless))).rejects.toThrow(
      /Too much Markdown received on stdin/,
    );

    const ceiling = Math.ceil(PUBLISH_STDIN_MAX_BYTES / chunk.length) + 1;
    expect(yielded).toBeLessThanOrEqual(ceiling);
  });
});
