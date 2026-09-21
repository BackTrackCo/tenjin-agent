export interface ResultPreview {
  result: string;
  format: 'json' | 'text';
  truncated: boolean;
  note?: string;
}

const PARTIAL_NOTE =
  'Bounded preview, not the complete response: strings, lists, or properties may be omitted. The full result is saved locally.';
const PROFILES = [
  { list: 16, string: 512, properties: 128 },
  { list: 8, string: 256, properties: 128 },
  { list: 4, string: 160, properties: 128 },
  { list: 2, string: 96, properties: 128 },
  { list: 2, string: 48, properties: 64 },
  { list: 2, string: 24, properties: 32 },
  { list: 2, string: 16, properties: 16 },
  { list: 1, string: 16, properties: 8 },
];
const MAX_VISITED = 20_000;
const MAX_DEPTH = 16;
// Small provenance scalars remain useful when a document has verbose metadata.
// Rank common keys globally so a list of incidental URLs cannot displace a late
// title or source URL. This is display priority, never provider-specific routing.
const PROVENANCE_KEYS = [
  'title',
  'sourceurl',
  'statuscode',
  'name',
  'url',
  'canonicalurl',
  'source',
  'status',
];
const MAX_PROVENANCE_FIELDS = 8;

/** A few dominant strings usually carry a document rather than tabular data.
 * Allocate prose by value size, never by provider or text instructions.
 * The structural profiles below still handle responses with many peer records. */
function prosePreview(parsed: unknown, maxChars: number): ResultPreview | undefined {
  type Path = Array<string | number>;
  const candidates: Array<{ path: Path; length: number }> = [];
  const provenance: Array<{ path: Path; rank: number }> = [];
  let visited = 0;
  let stringChars = 0;
  function scan(value: unknown, path: Path, depth: number): void {
    if (++visited > MAX_VISITED) throw new Error('Preview traversal limit');
    const key = path.at(-1);
    const rank =
      typeof key === 'string' ? PROVENANCE_KEYS.indexOf(key.replaceAll('_', '').toLowerCase()) : -1;
    if (
      rank >= 0 &&
      (typeof value === 'number' ||
        typeof value === 'boolean' ||
        (typeof value === 'string' && value.length <= 512))
    ) {
      provenance.push({ path, rank });
      provenance.sort((a, b) => a.rank - b.rank);
      provenance.length = Math.min(provenance.length, MAX_PROVENANCE_FIELDS);
    }
    if (typeof value === 'string') {
      stringChars += value.length;
      if (value.length >= Math.max(1024, maxChars / 2)) {
        candidates.push({ path, length: value.length });
        // Stable sorting gives equal-size values the same traversal-order tie break.
        candidates.sort((a, b) => b.length - a.length);
        candidates.length = Math.min(candidates.length, 4);
      }
      return;
    }
    if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return;
    if (Array.isArray(value))
      value.forEach((item, index) => scan(item, [...path, index], depth + 1));
    else for (const [key, item] of Object.entries(value)) scan(item, [...path, key], depth + 1);
  }
  try {
    scan(parsed, [], 0);
  } catch {
    return undefined;
  }
  if (
    candidates.length === 0 ||
    candidates.reduce((total, candidate) => total + candidate.length, 0) < stringChars * 0.6
  )
    return undefined;
  const prosePaths = new Set(candidates.map(({ path }) => JSON.stringify(path)));
  const provenancePaths = new Set(provenance.map(({ path }) => JSON.stringify(path)));
  const ancestors = new Set<string>();
  for (const { path } of [...candidates, ...provenance])
    for (let length = 0; length <= path.length; length++)
      ancestors.add(JSON.stringify(path.slice(0, length)));

  // Auxiliary breadth is bounded independently from the long text. In particular,
  // seventy metadata leaves must not each consume the document's string budget.
  for (const profile of [
    { list: 2, properties: 8, string: 64, provenance: 256 },
    { list: 1, properties: 4, string: 48, provenance: 128 },
    { list: 1, properties: 2, string: 24, provenance: 64 },
  ]) {
    function render(proseLimit: number): ResultPreview {
      let count = 0;
      let truncated = false;
      function visit(value: unknown, path: Path, depth: number): unknown {
        if (++count > MAX_VISITED) throw new Error('Preview traversal limit');
        if (typeof value === 'string') {
          const identity = JSON.stringify(path);
          const limit = prosePaths.has(identity)
            ? proseLimit
            : provenancePaths.has(identity)
              ? profile.provenance
              : profile.string;
          if (value.length <= limit) return value;
          let end = limit;
          // Do not split an astral character at the display boundary.
          const last = value.charCodeAt(end - 1);
          if (last >= 0xd800 && last <= 0xdbff) end--;
          truncated = true;
          return `${value.slice(0, end)}… [${value.length - end} chars omitted]`;
        }
        if (value === null || typeof value !== 'object') return value;
        if (depth >= MAX_DEPTH) {
          truncated = true;
          return '[nested content omitted from preview]';
        }
        if (Array.isArray(value)) {
          const kept = value.flatMap((item, index) => {
            const child = [...path, index];
            return index < profile.list || ancestors.has(JSON.stringify(child))
              ? [visit(item, child, depth + 1)]
              : [];
          });
          if (kept.length < value.length) {
            truncated = true;
            kept.push(`[${value.length - kept.length} items omitted from preview]`);
          }
          return kept;
        }
        const entries = Object.entries(value);
        const kept = entries.flatMap(([key, item], index) => {
          const child = [...path, key];
          return index < profile.properties || ancestors.has(JSON.stringify(child))
            ? [[key, visit(item, child, depth + 1)] as const]
            : [];
        });
        if (kept.length < entries.length) truncated = true;
        return Object.fromEntries(kept);
      }
      return {
        result: JSON.stringify(visit(parsed, [], 0)),
        format: 'json',
        truncated,
        ...(truncated ? { note: PARTIAL_NOTE } : {}),
      };
    }
    try {
      let best = render(0);
      // Reserve most of the serialized budget for the selected text, even when
      // several nested auxiliary objects would individually fit their limits.
      if (best.result.length > maxChars / 4) continue;
      let lower = 0;
      let upper = maxChars;
      // A shared per-string cap allocates comparable document fields fairly.
      // Measuring serialized JSON accounts for quotes, escapes, and wrappers.
      while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2);
        const preview = render(middle);
        if (preview.result.length <= maxChars) {
          best = preview;
          lower = middle + 1;
        } else upper = middle - 1;
      }
      return best;
    } catch {
      // Try a narrower surrounding tree before falling back to record profiles.
    }
  }
  return undefined;
}

/** Deterministic display only; execution and its saved response keep the full body. */
export function previewResult(body: string, maxChars = 6000): ResultPreview {
  if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 6000)
    throw new Error('Result preview limit must be an integer from 256 to 6000.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const truncated = body.length > maxChars;
    return {
      result: truncated ? `${body.slice(0, maxChars - 16)}\n[truncated]` : body,
      format: 'text',
      truncated,
      ...(truncated ? { note: PARTIAL_NOTE } : {}),
    };
  }
  // Whitespace reduction alone is lossless; it must not be labeled truncation.
  // Deeply nested JSON can parse successfully but exceed stringify's stack.
  try {
    const complete = JSON.stringify(parsed);
    if (complete.length <= maxChars) return { result: complete, format: 'json', truncated: false };
  } catch {
    // The depth-limited traversal below still yields a valid JSON preview.
  }
  const prose = prosePreview(parsed, maxChars);
  if (prose) return prose;
  for (const profile of PROFILES) {
    let visited = 0;
    let truncated = false;
    function visit(value: unknown, depth: number): unknown {
      if (++visited > MAX_VISITED) throw new Error('Preview traversal limit');
      if (typeof value === 'string') {
        if (value.length <= profile.string) return value;
        truncated = true;
        return `${value.slice(0, profile.string)}… [${value.length - profile.string} chars omitted]`;
      }
      if (value === null || typeof value !== 'object') return value;
      if (depth >= MAX_DEPTH) {
        truncated = true;
        return '[nested content omitted from preview]';
      }
      if (Array.isArray(value)) {
        const result = value.slice(0, profile.list).map((item) => visit(item, depth + 1));
        if (value.length > profile.list) {
          truncated = true;
          result.push(`[${value.length - profile.list} items omitted from preview]`);
        }
        return result;
      }
      const entries = Object.entries(value);
      if (entries.length > profile.properties) truncated = true;
      return Object.fromEntries(
        entries.slice(0, profile.properties).map(([key, item]) => [key, visit(item, depth + 1)]),
      );
    }
    try {
      const result = JSON.stringify(visit(parsed, 0));
      if (result.length <= maxChars)
        return {
          result,
          format: 'json',
          truncated,
          ...(truncated ? { note: PARTIAL_NOTE } : {}),
        };
    } catch {
      // Retry the entire tree uniformly; never deliver a broken JSON prefix.
    }
  }
  return {
    result: JSON.stringify('[Response structure exceeds the bounded preview.]'),
    format: 'json',
    truncated: true,
    note: PARTIAL_NOTE,
  };
}
