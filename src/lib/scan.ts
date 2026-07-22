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
 *
 * The provider token-shape patterns (AWS, GitHub, Slack, Stripe, JWT, PEM) are
 * adapted from the gitleaks ruleset (MIT); the EVM raw-key (0x + 64 hex) and
 * wallet-address checks continue the BlockRun-credited wallet-key leak scanner.
 * Both are attributed in NOTICE.md. No pattern set is vendored as a dependency —
 * this is a wallet-holding CLI, kept offline with a tight dep tree by design.
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
    ...scanHex64(lines),
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
  /** Drop this match without a finding (e.g. a placeholder value). */
  skip?: (m: RegExpExecArray) => boolean;
}

const LINE_DETECTORS: LineDetector[] = [
  // Secrets/keys — severity block, excerpt always masked. Provider patterns
  // adapted from gitleaks (MIT). The 0x-64-hex EVM key is handled separately
  // (scanHex64) so a tx/block hash is not hard-blocked. See header + NOTICE.md.
  {
    check: 'aws-access-key',
    severity: 'block',
    // gitleaks aws-access-token.
    re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    excerpt: (m) => maskKeeping(m[0], 4),
  },
  {
    check: 'jwt',
    severity: 'block',
    // gitleaks jwt (three base64url segments, header starts eyJ).
    re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    excerpt: (m) => maskKeeping(m[0], 3),
  },
  {
    check: 'github-token',
    severity: 'block',
    // gitleaks github-pat / -oauth / -app / -refresh (36 chars) + fine-grained pat.
    re: /\b(?:gh[posru]_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{82})\b/g,
    excerpt: (m) => maskKeeping(m[0], 4),
  },
  {
    check: 'slack-token',
    severity: 'block',
    // gitleaks slack tokens (bot/user/app/refresh/legacy prefixes).
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    excerpt: (m) => maskKeeping(m[0], 5),
  },
  {
    check: 'stripe-token',
    severity: 'block',
    // gitleaks stripe-access-token.
    re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{10,99}\b/g,
    excerpt: (m) => maskKeeping(m[0], 8),
  },
  {
    check: 'anthropic-key',
    severity: 'block',
    // gitleaks anthropic-api-key. Ordered before openai so sk-ant- isn't
    // mis-typed as a bare OpenAI sk- key.
    re: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/g,
    excerpt: (m) => maskKeeping(m[0], 7),
  },
  {
    check: 'openai-key',
    severity: 'block',
    // gitleaks openai-api-key (classic sk- and project sk-proj- keys).
    re: /\bsk-(?:proj-)?[0-9A-Za-z]{20,}\b/g,
    excerpt: (m) => maskKeeping(m[0], 3),
  },
  {
    check: 'google-key',
    severity: 'block',
    // gitleaks gcp-api-key (AIza) and gcp-oauth-client-secret (GOCSPX-).
    re: /\b(?:AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{20,})\b/g,
    excerpt: (m) => maskKeeping(m[0], m[0].startsWith('AIza') ? 4 : 7),
  },
  {
    check: 'npm-token',
    severity: 'block',
    // gitleaks npm-access-token.
    re: /\bnpm_[0-9A-Za-z]{36}\b/g,
    excerpt: (m) => maskKeeping(m[0], 4),
  },
  {
    check: 'db-connection-uri',
    severity: 'block',
    // A connection string with an embedded password (scheme://user:pass@host).
    // Only the password (group 3) is secret; the excerpt masks it and keeps the
    // rest so the finding is legible.
    re: /\b([a-z][a-z0-9+.-]*):\/\/([^\s:@/]+):([^\s@/]+)@([^\s/:]+)/gi,
    excerpt: (m) => `${m[1]}://${m[2]}:[redacted]@${m[4]}`,
  },
  {
    check: 'bearer-token',
    severity: 'block',
    // An Authorization: Bearer header carrying a live token; placeholder-gated
    // like secret-assignment so `Bearer <token>` examples don't hard-block.
    re: /\bAuthorization:\s*Bearer\s+(\S{8,})/gi,
    excerpt: (m) => `Authorization: Bearer [redacted ${m[1]?.length ?? 0} chars]`,
    skip: (m) => isPlaceholder(m[1] ?? ''),
  },
  // Generic secret-named assignment — WARN, not block (review): a keyword match is
  // lower-confidence than a structured shape, and warn still forces confirmation
  // in default auto mode, so nothing publishes unseen while benign config
  // (SECRET_NAME=…, MYSQL_ROOT_PASSWORD=…) is not permanently non-bypassable. The
  // excerpt stays masked. Placeholder and structural (path/URL/regex) values are
  // skipped entirely.
  {
    check: 'secret-assignment',
    severity: 'warn',
    // Key: api[_-]?key, secret, access/private key, passw(or)?d, token,
    // credential(s), auth token — camelCase-insensitive. Value: a quoted string
    // (interior spaces allowed) or an unquoted run, ≥6 chars. Value is masked.
    re: /\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSW(?:OR)?D|TOKEN|CREDENTIALS?|AUTH[_-]?TOKEN)[A-Za-z0-9_]*)\s*[:=]\s*("[^"]{6,}"|'[^']{6,}'|[^\s"']{6,})/gi,
    excerpt: (m) => `${m[1]}=[redacted ${dequote(m[2] ?? '').length} chars]`,
    skip: (m) => {
      const value = dequote(m[2] ?? '');
      return isPlaceholder(value) || isStructural(value);
    },
  },
  // Wallet addresses — warn (a contract address may be intentional). Not a secret,
  // shown abbreviated. viem's checksum validation is deliberately NOT used to gate
  // this: EIP-55 strict validation rejects the valid all-lowercase/all-uppercase
  // forms, which a scanner must still surface, so shape matching is the right test.
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
        const zeroWidth = m[0].length === 0;
        if (!detector.skip?.(m)) {
          out.push({
            check: detector.check,
            severity: detector.severity,
            line: i + 1,
            span: [m.index, m.index + m[0].length],
            excerpt: detector.excerpt(m),
          });
        }
        if (zeroWidth) detector.re.lastIndex++; // guard a zero-width match
      }
    }
  }
  return out;
}

// Accepted alpha gaps (owner call, tracked for post-alpha): BIP-39 mnemonic
// phrases (12/24 dictionary words) are NOT detected — a wordlist match is
// high-false-positive against prose and deferred. Headerless base64/DER-encoded
// private keys (no -----BEGIN----- marker) are likewise NOT detected; only the
// PEM-armored form and the 0x-64-hex form are.

/** Strip a single matching pair of surrounding quotes from a captured value. */
function dequote(value: string): string {
  const m = /^"([^"]*)"$|^'([^']*)'$/.exec(value);
  return m !== null ? (m[1] ?? m[2] ?? '') : value;
}

/** A secret-assignment value that is an obvious placeholder, not a live secret. */
function isPlaceholder(value: string): boolean {
  if (/^[<${%]/.test(value)) return true; // <your-key>, ${VAR}, {{x}}, %ENV%
  return /^(?:your[-_]?|my[-_]?|xxx+$|example|placeholder|redacted|changeme|dummy|sample|\*+$|\.\.\.)/i.test(
    value,
  );
}

/** A structural value (path, URL, or regex literal), not a literal secret. */
function isStructural(value: string): boolean {
  return /^(?:\.?\.?\/|~\/|https?:\/\/|\^)/.test(value);
}

// EVM raw private key (0x + 64 hex) vs. a 32-byte hash. On Base the two are
// syntactically identical, and a block finding is permanently non-bypassable, so
// a post carrying an x402 receipt / basescan tx hash must not be hard-blocked.
// A 64-hex is demoted to a warn 'hex32-value' when the context reads as a hash:
// it sits inside an http(s) URL token, or is labelled tx/txhash/txn/hash/
// blockhash just before it. A bare, uncontextualized 64-hex stays a block
// 'raw-private-key' (continuing the BlockRun-credited wallet-key scanner).
const HEX64_RE = /(?<![0-9a-fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi;
const HASH_LABEL_RE = /(?:^|[^a-z0-9])(?:blockhash|txhash|txn|tx|hash)[\s/:=]*$/i;

function scanHex64(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    HEX64_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEX64_RE.exec(line)) !== null) {
      const hash = isHashContext(line, m.index);
      out.push({
        check: hash ? 'hex32-value' : 'raw-private-key',
        severity: hash ? 'warn' : 'block',
        line: i + 1,
        span: [m.index, m.index + m[0].length],
        excerpt: hash ? `${m[0].slice(0, 6)}…${m[0].slice(-4)}` : maskKeeping(m[0], 2),
      });
    }
  }
  return out;
}

function isHashContext(line: string, matchIndex: number): boolean {
  const before = line.slice(0, matchIndex);
  if (HASH_LABEL_RE.test(before)) return true;
  // The whitespace-delimited token containing the match starts with http(s)://.
  const prefix = /(\S*)$/.exec(before)?.[1] ?? '';
  return /^https?:\/\//.test(line.slice(matchIndex - prefix.length));
}

// gitleaks private-key marker (RSA/EC/OPENSSH/PGP variants, optional BLOCK).
const PEM_BEGIN = /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/;

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
