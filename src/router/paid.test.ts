import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SENT_CHARS, mediaUrlsIn, recordedSent, saveMedia } from './paid';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-paid-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PUBLIC = { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] };

describe('what the ledger records as sent', () => {
  it('masks a secret, then cuts to 4 KB', () => {
    const secret = `sk-ant-api03-${'a'.repeat(90)}`;
    const sent = recordedSent(`use ${secret} ${'x'.repeat(10_000)}`);
    expect(sent).not.toContain(secret);
    expect(sent).toHaveLength(MAX_SENT_CHARS);
  });
});

describe('the media a paid result links to', () => {
  it('finds https media links by extension, once each, at most five', () => {
    const body = JSON.stringify({
      a: 'https://cdn.test/a.PNG',
      b: 'https://cdn.test/a.PNG',
      c: 'http://cdn.test/plain.mp3',
      d: 'https://cdn.test/page.html',
      e: 'https://cdn.test/v.mp4?sig=1',
      f: [
        'https://c.test/1.wav',
        'https://c.test/2.ogg',
        'https://c.test/3.gif',
        'https://c.test/4.mov',
      ],
    });
    expect(mediaUrlsIn(body)).toEqual([
      'https://cdn.test/a.PNG',
      'https://cdn.test/v.mp4?sig=1',
      'https://c.test/1.wav',
      'https://c.test/2.ogg',
      'https://c.test/3.gif',
    ]);
  });

  it('follows a redirect only to a public destination, and caps the size', async () => {
    const hops: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      hops.push(String(input));
      if (String(input).endsWith('/start.png')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.test/real.png' },
        });
      }
      if (String(input).endsWith('/big.png')) return new Response(new Uint8Array(64));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const saved = await saveMedia(
      dir,
      'cap',
      ['https://cdn.test/start.png', 'https://cdn.test/big.png'],
      { fetchImpl, destination: PUBLIC, now: () => 7, maxBytes: 16 },
    );
    expect(hops).toEqual([
      'https://cdn.test/start.png',
      'https://cdn.test/real.png',
      'https://cdn.test/big.png',
    ]);
    expect(saved).toEqual([join(dir, 'downloads', 'cap-1-7.png')]);
    expect(new Uint8Array(await readFile(saved[0]!))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a redirect to a private address', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/a.png' },
      })) as typeof fetch;
    const saved = await saveMedia(dir, 'cap', ['https://cdn.test/a.png'], {
      fetchImpl,
      destination: PUBLIC,
    });
    expect(saved).toEqual([]);
  });
});
