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
  for (const profile of PROFILES) {
    let visited = 0;
    let truncated = false;
    function visit(value: unknown, depth: number): unknown {
      if (++visited > 20000) throw new Error('Preview traversal limit');
      if (typeof value === 'string') {
        if (value.length <= profile.string) return value;
        truncated = true;
        return `${value.slice(0, profile.string)}… [${value.length - profile.string} chars omitted]`;
      }
      if (value === null || typeof value !== 'object') return value;
      if (depth >= 16) {
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
