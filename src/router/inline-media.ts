import { MAX_MEDIA_FILES } from './paid';

/**
 * A PAID FILE CARRIED INSIDE THE JSON, saved to disk instead of handed to the
 * agent as text. A generator can answer with the file itself as base64: a
 * four-second video came back as `{"data":[{"b64_json":"<4.2 MB>",
 * "media_type":"video/mp4"}]}`, and the agent stalled decoding it by hand.
 *
 * A string is a file when it is a `data:<type>;base64,` URI, when it sits
 * under a key naming base64 (`b64_json`, `b64`, `audio_base64`,
 * `bytesBase64Encoded`), or when its bytes open like a known media file;
 * in every case it is valid base64 of at least {@link MIN_INLINE_BYTES}, so
 * an id or a hash that happens to look like base64 stays where it is.
 */

/** Below this a base64 string is an id, a hash or a token, not a file. */
export const MIN_INLINE_BYTES = 1024;

/** Deep enough for `{data: [{b64_json}]}` and its cousins, and no deeper. */
const MAX_DEPTH = 8;

const DATA_URI = /^data:([^;,]*)[^,]*;base64,/i;
const BASE64_KEY = /base64|^b64(?:_json)?$/i;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MEDIA_TYPE = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/i;
/** Sibling keys that name the file's type, compared without `_` or case. */
const TYPE_KEYS = new Set(['mediatype', 'mimetype', 'contenttype']);

/** Where one inline file sits, and what it is. */
interface Found {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Every inline file in `bodyText`, saved with `save` and replaced by a note
 * naming where it went, its type and its size: the rewritten JSON and the
 * paths. At most `limit` files. A file `save` could not write stays inline.
 * Null when the body is not JSON, holds no inline file, or nothing was saved.
 *
 * NEVER THROWS: it runs after the money moved, and any failure leaves the
 * body exactly as it came.
 */
export async function saveInlineMedia(
  bodyText: string,
  save: (bytes: Uint8Array, contentType: string) => Promise<string | null>,
  limit = MAX_MEDIA_FILES,
): Promise<{ bodyText: string; savedFiles: string[] } | null> {
  try {
    const root: unknown = JSON.parse(bodyText);
    const found: Found[] = [];
    collect(root, undefined, undefined, 0, found, limit);
    const savedFiles: string[] = [];
    for (const file of found) {
      const path = await save(file.bytes, file.contentType).catch(() => null);
      if (path === null) continue;
      savedFiles.push(path);
      const note = `[inline file saved to ${path} (${file.contentType}, ${file.bytes.byteLength} bytes)]`;
      if (Array.isArray(file.holder)) file.holder[file.key as number] = note;
      else file.holder[file.key as string] = note;
    }
    if (savedFiles.length === 0) return null;
    return { bodyText: JSON.stringify(root), savedFiles };
  } catch {
    return null;
  }
}

/** Walk `value`, which sits at `holder[key]`; an array's items take the key
 *  and the siblings of the object that holds the array. */
function collect(
  value: unknown,
  at: { holder: Record<string, unknown> | unknown[]; key: string | number } | undefined,
  named: { key: string; siblings: Record<string, unknown> } | undefined,
  depth: number,
  found: Found[],
  limit: number,
): void {
  if (found.length >= limit || depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    if (at === undefined) return;
    const file = inlineFile(value, named);
    if (file !== null) found.push({ ...at, ...file });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collect(item, { holder: value, key: index }, named, depth + 1, found, limit),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(object)) {
    collect(item, { holder: object, key }, { key, siblings: object }, depth + 1, found, limit);
  }
}

/** The file a string carries, or null when it carries none. */
function inlineFile(
  text: string,
  named: { key: string; siblings: Record<string, unknown> } | undefined,
): { bytes: Uint8Array; contentType: string } | null {
  // Too short to hold a file once decoded: skipped before any regex runs.
  if (text.length < Math.ceil((MIN_INLINE_BYTES * 4) / 3)) return null;
  const uri = DATA_URI.exec(text);
  const payload = uri !== null ? text.slice(uri[0].length) : text;
  const bytes = decoded(payload);
  if (bytes === null) return null;
  const magic = sniff(bytes);
  if (uri === null && magic === null && !BASE64_KEY.test(named?.key ?? '')) return null;
  const declared = uri?.[1] !== undefined && MEDIA_TYPE.test(uri[1]) ? uri[1] : siblingType(named);
  return {
    bytes,
    contentType: (declared ?? magic ?? 'application/octet-stream').toLowerCase(),
  };
}

/** Valid base64 (standard or URL-safe, line breaks allowed) of at least
 *  {@link MIN_INLINE_BYTES}, decoded; null otherwise. */
function decoded(payload: string): Uint8Array | null {
  const compact = payload.replace(/[\r\n]+/g, '');
  if (!BASE64.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  return bytes.byteLength >= MIN_INLINE_BYTES ? new Uint8Array(bytes) : null;
}

/** The type a sibling key declares (`media_type`, `mimeType`, ...), if any. */
function siblingType(
  named: { key: string; siblings: Record<string, unknown> } | undefined,
): string | undefined {
  if (named === undefined) return undefined;
  for (const [key, value] of Object.entries(named.siblings)) {
    if (!TYPE_KEYS.has(key.replace(/_/g, '').toLowerCase())) continue;
    if (typeof value === 'string' && MEDIA_TYPE.test(value.trim())) return value.trim();
  }
  return undefined;
}

/** The media type the first bytes name, for the formats a paid lookup
 *  plausibly returns; null for anything else. */
export function sniff(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) =>
    Buffer.from(bytes.subarray(from, to)).toString('latin1');
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  // An MPEG audio frame with no ID3 tag: eleven sync bits.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}
