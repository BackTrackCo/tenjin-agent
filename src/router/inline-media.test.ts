import { describe, expect, it, vi } from 'vitest';
import { MIN_INLINE_BYTES, saveInlineMedia, sniff } from './inline-media';

/**
 * A FILE INSIDE THE JSON leaves it: decoded, saved, and replaced by a note
 * naming where it went. An id or a hash that looks like base64 stays.
 */

/** `size` bytes that open with `head`, then filler. */
function file(head: number[], size = 4 * 1024): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x2a);
  bytes.set(head);
  return bytes;
}

const MP4 = file([0x00, 0x00, 0x00, 0x18, ...Buffer.from('ftypisom')]);
const PNG = file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A save that records what it was handed and names a path per file. */
function recorder() {
  const saved: { bytes: Uint8Array; contentType: string }[] = [];
  const save = vi.fn(async (bytes: Uint8Array, contentType: string) => {
    saved.push({ bytes, contentType });
    return `/downloads/file-${saved.length}`;
  });
  return { saved, save };
}

describe('inline media in a paid JSON body', () => {
  it('saves the video agent402 returned as b64_json, typed by its media_type', async () => {
    const body = JSON.stringify({
      data: [{ b64_json: b64(MP4), media_type: 'video/mp4', duration_seconds: 4 }],
    });
    const { saved, save } = recorder();
    const out = await saveInlineMedia(body, save);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.contentType).toBe('video/mp4');
    expect(Buffer.from(saved[0]!.bytes).equals(Buffer.from(MP4))).toBe(true);
    expect(out!.savedFiles).toEqual(['/downloads/file-1']);
    expect(JSON.parse(out!.bodyText)).toEqual({
      data: [
        {
          b64_json: `[inline file saved to /downloads/file-1 (video/mp4, ${MP4.byteLength} bytes)]`,
          media_type: 'video/mp4',
          duration_seconds: 4,
        },
      ],
    });
  });

  it('saves a data URI, typed by the URI', async () => {
    const body = JSON.stringify({ image: `data:image/png;base64,${b64(PNG)}`, seed: 7 });
    const { saved, save } = recorder();
    const out = await saveInlineMedia(body, save);
    expect(saved.map((s) => s.contentType)).toEqual(['image/png']);
    expect(JSON.parse(out!.bodyText)).toEqual({
      image: `[inline file saved to /downloads/file-1 (image/png, ${PNG.byteLength} bytes)]`,
      seed: 7,
    });
  });

  it('leaves a short base64-looking id, hash or token alone, even under a base64 key', async () => {
    const body = JSON.stringify({
      id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d12',
      sha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
      b64_json: 'aGVsbG8gd29ybGQ=',
      image: 'data:image/png;base64,iVBORw0KGgo=',
    });
    const { save } = recorder();
    expect(await saveInlineMedia(body, save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('leaves long text alone, and a long base64 string under a plain key that opens like no file', async () => {
    const body = JSON.stringify({
      article: 'word '.repeat(2_000),
      blob: b64(file([0x01, 0x02, 0x03])),
    });
    const { save } = recorder();
    expect(await saveInlineMedia(body, save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves a file under a plain key when its bytes open like one, typed by them', async () => {
    const body = JSON.stringify({ result: { image: b64(PNG) } });
    const { saved, save } = recorder();
    const out = await saveInlineMedia(body, save);
    expect(saved.map((s) => s.contentType)).toEqual(['image/png']);
    expect(out!.savedFiles).toHaveLength(1);
  });

  it('types an undeclared file by its bytes, and an unknown one as octet-stream', async () => {
    const body = JSON.stringify({
      audio_base64: b64(file([...Buffer.from('ID3'), 0x04])),
      bytesBase64Encoded: b64(file([0x01, 0x02, 0x03])),
    });
    const { saved, save } = recorder();
    await saveInlineMedia(body, save);
    expect(saved.map((s) => s.contentType)).toEqual(['audio/mpeg', 'application/octet-stream']);
  });

  it('reads a type from a mimeType sibling, and base64 broken over lines', async () => {
    const wrapped = b64(MP4).replace(/(.{76})/g, '$1\n');
    const body = JSON.stringify({ video: { base64: wrapped, mimeType: 'video/quicktime' } });
    const { saved, save } = recorder();
    await saveInlineMedia(body, save);
    expect(saved.map((s) => s.contentType)).toEqual(['video/quicktime']);
    expect(Buffer.from(saved[0]!.bytes).equals(Buffer.from(MP4))).toBe(true);
  });

  it('saves at most the limit, and leaves the rest inline', async () => {
    const body = JSON.stringify({ data: [1, 2, 3].map(() => ({ b64_json: b64(PNG) })) });
    const { save } = recorder();
    const out = await saveInlineMedia(body, save, 2);
    expect(out!.savedFiles).toHaveLength(2);
    const items = (JSON.parse(out!.bodyText) as { data: { b64_json: string }[] }).data;
    expect(items[2]!.b64_json).toBe(b64(PNG));
  });

  it('keeps a file inline when it cannot be saved, and never throws', async () => {
    const body = JSON.stringify({ b64_json: b64(PNG) });
    expect(await saveInlineMedia(body, async () => null)).toBeNull();
    expect(
      await saveInlineMedia(body, async () => {
        throw new Error('disk full');
      }),
    ).toBeNull();
    expect(await saveInlineMedia('not json', async () => '/x')).toBeNull();
  });

  it('needs at least MIN_INLINE_BYTES decoded', async () => {
    const { save } = recorder();
    const under = JSON.stringify({ b64_json: b64(file([], MIN_INLINE_BYTES - 1)) });
    const at = JSON.stringify({ b64_json: b64(file([], MIN_INLINE_BYTES)) });
    expect(await saveInlineMedia(under, save)).toBeNull();
    expect(await saveInlineMedia(at, save)).not.toBeNull();
  });
});

describe('the type a file opens with', () => {
  it.each([
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
    ['image/gif', [...Buffer.from('GIF89a')]],
    ['image/webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]],
    ['audio/wav', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')]],
    ['video/mp4', [0, 0, 0, 0x18, ...Buffer.from('ftypisom')]],
    ['video/quicktime', [0, 0, 0, 0x14, ...Buffer.from('ftypqt  ')]],
    ['audio/mp4', [0, 0, 0, 0x20, ...Buffer.from('ftypM4A ')]],
    ['video/webm', [0x1a, 0x45, 0xdf, 0xa3]],
    ['audio/ogg', [...Buffer.from('OggS')]],
    ['audio/flac', [...Buffer.from('fLaC')]],
    ['application/pdf', [...Buffer.from('%PDF-1.7')]],
    ['audio/mpeg', [...Buffer.from('ID3'), 0x04]],
    ['audio/mpeg', [0xff, 0xfb, 0x90, 0x00]],
  ])('%s', (type, head) => {
    expect(sniff(file(head, 64))).toBe(type);
  });

  it('names nothing for bytes it does not know', () => {
    expect(sniff(file([0x01, 0x02], 64))).toBeNull();
  });
});
