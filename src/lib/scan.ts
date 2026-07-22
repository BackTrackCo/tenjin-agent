/**
 * The deterministic, offline redaction/rights scan (B3, Q14). Pure: identical
 * input yields an identical `findings[]`, no network and no model call. It runs
 * in every publish mode — it gates the explicit-approval gate, it does not
 * replace it. `block` findings refuse a publish in every mode and are never
 * `--yes`-clearable; `warn` findings are surfaced for review.
 *
 * A `block` excerpt is ALWAYS masked: the matched secret is never echoed
 * verbatim, only a short type-identifying prefix plus a redaction. `warn`
 * excerpts (wallet addresses, PII, quotes) show the caller their own content.
 */

export type ScanSeverity = 'block' | 'warn';

export interface ScanFinding {
  /** Stable machine id for the detector, e.g. "aws-access-key". */
  check: string;
  severity: ScanSeverity;
  /** 1-based line number of the match (its start line, for multi-line matches). */
  line: number;
  /** [startColumn, endColumn) within `line`, 0-based (the start line for spans). */
  span: [number, number];
  /** Human-readable snippet; masked for every `block` finding. */
  excerpt: string;
}

/** Contiguous quoted/fenced runs at or above this word count read as copied. */
const LONG_QUOTE_WORDS = 80;

export function scan(text: string): ScanFinding[] {
  const lines = text.split('\n');
  const findings: ScanFinding[] = [
    ...scanLineDetectors(lines),
    ...scanPemBlocks(lines),
    ...scanLongVerbatim(lines),
  ];
  return dedupeAndSort(findings);
}

/**
 * Never echo more than a short, non-secret prefix. The kept prefix is a public
 * type marker (`0x`, `AKIA`, `ghp_`, …), never key material; the rest is dropped.
 */
function maskKeeping(match: string, prefixLen: number): string {
  const prefix = match.slice(0, Math.min(prefixLen, match.length));
  return `${prefix}…[redacted ${match.length - prefix.length} chars]`;
}

interface LineDetector {
  check: string;
  severity: ScanSeverity;
  /** Global regex; `lastIndex` is reset per line. */
  re: RegExp;
  /** Build the (possibly masked) excerpt from a single match. */
  excerpt: (m: RegExpExecArray) => string;
}

const LINE_DETECTORS: LineDetector[] = [
  // Secrets/keys — severity block, excerpt always masked.
  {
    check: 'raw-private-key',
    severity: 'block',
    re: /(?<![0-9a-fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi,
    excerpt: (m) => maskKeeping(m[0], 2),
  },
  {
    check: 'aws-access-key',
    severity: 'block',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    excerpt: (m) => maskKeeping(m[0], 4),
  },
  {
    check: 'jwt',
    severity: 'block',
    re: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    excerpt: (m) => maskKeeping(m[0], 3),
  },
  {
    check: 'github-token',
    severity: 'block',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    excerpt: (m) => maskKeeping(m[0], 4),
  },
  {
    check: 'slack-token',
    severity: 'block',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    excerpt: (m) => maskKeeping(m[0], 5),
  },
  {
    check: 'stripe-token',
    severity: 'block',
    re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    excerpt: (m) => maskKeeping(m[0], 8),
  },
  {
    check: 'secret-assignment',
    severity: 'block',
    // A secret-named key = a non-placeholder value. The value (group 2) is masked.
    re: /\b([A-Z0-9_]*(?:API_KEY|SECRET|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|AUTH_TOKEN)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"']{6,})/gi,
    excerpt: (m) => `${m[1]}=[redacted ${m[2]?.length ?? 0} chars]`,
  },
  // Wallet addresses — warn (a contract address may be intentional). Not a secret,
  // but shown abbreviated for readability.
  {
    check: 'wallet-address',
    severity: 'warn',
    re: /(?<![0-9a-fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/gi,
    excerpt: (m) => `${m[0].slice(0, 6)}…${m[0].slice(-4)}`,
  },
  // Employer-internal markers — warn.
  {
    check: 'confidential-marker',
    severity: 'warn',
    re: /\b(?:CONFIDENTIAL|INTERNAL ONLY)\b/gi,
    excerpt: (m) => m[0],
  },
  {
    check: 'internal-hostname',
    severity: 'warn',
    re: /\b(?:[a-z0-9-]+\.)+(?:internal|corp|local|lan|intranet)\b/gi,
    excerpt: (m) => m[0],
  },
  // Personal data — warn. `email` subsumes corp-domain emails (an internal marker).
  {
    check: 'email',
    severity: 'warn',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    excerpt: (m) => m[0],
  },
  {
    check: 'phone',
    severity: 'warn',
    re: /(?<!\d)(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g,
    excerpt: (m) => m[0],
  },
];

function scanLineDetectors(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const detector of LINE_DETECTORS) {
      detector.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = detector.re.exec(line)) !== null) {
        out.push({
          check: detector.check,
          severity: detector.severity,
          line: i + 1,
          span: [m.index, m.index + m[0].length],
          excerpt: detector.excerpt(m),
        });
        if (m[0].length === 0) detector.re.lastIndex++; // guard a zero-width match
      }
    }
  }
  return out;
}

const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9 ]*)?PRIVATE KEY-----/;

/** A PEM private-key block is a single block finding on its BEGIN marker line. */
function scanPemBlocks(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = PEM_BEGIN.exec(line);
    if (m !== null) {
      out.push({
        check: 'pem-private-key',
        severity: 'block',
        line: i + 1,
        span: [m.index, m.index + m[0].length],
        excerpt: m[0], // the header marker only — no key material follows on it
      });
    }
  }
  return out;
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Long verbatim runs — warn (a rights, not a secrets, concern). A fenced code
 * block or a contiguous `>` blockquote whose content reaches LONG_QUOTE_WORDS
 * reads as copied third-party material. Reported once on the run's first line.
 */
function scanLongVerbatim(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[2] ?? '```';
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i] ?? '', marker)) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // consume the closing fence (or run off the end)
      pushIfLong(out, body, start, line);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const start = i;
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      pushIfLong(out, body, start, lines[start] ?? '');
      continue;
    }
    i++;
  }
  return out;
}

function closesFence(line: string, marker: string): boolean {
  const m = FENCE.exec(line);
  return m !== null && (m[2] ?? '').startsWith(marker);
}

function pushIfLong(
  out: ScanFinding[],
  body: string[],
  startLine: number,
  firstLine: string,
): void {
  const text = body.join(' ').trim();
  const words = text.length === 0 ? 0 : text.split(/\s+/).length;
  if (words < LONG_QUOTE_WORDS) return;
  const excerpt = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  out.push({
    check: 'long-verbatim-quote',
    severity: 'warn',
    line: startLine + 1,
    span: [0, firstLine.length],
    excerpt,
  });
}

/**
 * Deterministic order: line, then start column, then check name. Exact duplicate
 * spans of the same check (e.g. two detectors on the same offset) collapse to one.
 */
function dedupeAndSort(findings: ScanFinding[]): ScanFinding[] {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.check}:${f.line}:${f.span[0]}:${f.span[1]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(
    (a, b) => a.line - b.line || a.span[0] - b.span[0] || a.check.localeCompare(b.check),
  );
}
