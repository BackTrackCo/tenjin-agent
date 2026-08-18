/**
 * The deterministic, offline redaction/rights scan (B3, Q14). Pure: identical
 * input yields an identical `findings[]`, no network and no model call. It runs
 * in every publish mode — it gates the explicit-approval gate, it does not
 * replace it. `block` findings refuse a publish in every mode and are never
 * `--yes`-clearable; `warn` findings are surfaced for review.
 *
 * Three invariants, all pinned by scan.corpus.test.ts and scan.test.ts:
 *
 * REDACTION: a `block` excerpt is masked — a type-identifying prefix plus a
 * redaction count, never the matched secret. `pem-private-key` is the one
 * exception, its excerpt being the armor header. Secret-shaped warns
 * (secret-assignment, customer-identifier, high-entropy-string) are masked too.
 * A finding travels as detector id + tier + offsets + redacted excerpt.
 *
 * TIER ORDERING: suppression may downgrade a warn, never a block. Block-tier
 * suppression is per-detector and anchored to the captured secret value; no
 * substring rule may reach it (see DOCS_PLACEHOLDER).
 *
 * ReDoS: no pattern may contain a quantified group whose body can also match the
 * group's own separator while a further obligation follows it. Audited against a
 * single line of hundreds of kilobytes, the shape a JSONL transcript record takes.
 *
 * The detector corpus lives as DATA in `scan-rules.json` so the tenjin
 * server-side ingest gate can vendor it verbatim; this file compiles that data
 * and implements the handlers and algorithmic detectors it names. Per-rule
 * attribution is in the data file's `source` field and in NOTICE.md. No pattern
 * set is a runtime dependency: this is a wallet-holding CLI, kept offline with a
 * tight dep tree by design.
 */

import corpusJson from './scan-rules.json';
import wordlistJson from './bip39-wordlist.json';

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

/**
 * Optional caller-supplied context. The scan stays a pure function — of the text
 * AND the context — with zero model calls; the context only carries deterministic
 * facts the caller already holds (the source project's git remote slugs/paths at
 * publish time, per the open-questions publishing-safety check-set).
 */
export interface ScanContext {
  /**
   * Source-project identifiers treated as private-by-default: git remote
   * `org/repo` slugs and project paths. Matched case-insensitively as literal
   * substrings; a mention in the draft warns (the project may be public — the
   * offline scan cannot know — so this is ambiguity-class, never block).
   */
  projectMarkers?: string[];
}

/** Contiguous quoted/fenced runs at or above this word count read as copied. */
const LONG_QUOTE_WORDS = 80;

export function scan(text: string, context: ScanContext = {}): ScanFinding[] {
  const lines = text.split('\n');
  const findings: ScanFinding[] = [
    ...scanHex64(lines),
    ...scanLineDetectors(lines),
    ...scanPemBlocks(lines),
    ...scanSeedPhrases(lines),
    ...scanEnvDumpBlocks(lines),
    ...scanLongVerbatim(lines),
    ...scanProjectMarkers(lines, context.projectMarkers ?? []),
  ];
  const named = dedupeAndSort(suppressEmailsInDbUris(findings));
  return dedupeAndSort([...named, ...scanHighEntropy(lines, named)]);
}

// ---------------------------------------------------------------------------
// Rule corpus: scan-rules.json compiled into executable detectors.
// ---------------------------------------------------------------------------

interface RuleExcerpt {
  kind: string;
  keep?: number;
  max?: number;
  head?: number;
  tail?: number;
  handler?: string;
}

interface Rule {
  id: string;
  tier: string;
  description: string;
  source: string;
  match: { kind: string; pattern?: string; flags?: string; algorithm?: string };
  excerpt: RuleExcerpt;
  skip?: { handler: string };
}

const CORPUS = corpusJson as unknown as {
  schemaVersion: number;
  rules: Rule[];
  publicHexConstants?: Array<{ value: string; name: string }>;
};

/** Algorithmic detectors this file implements; a corpus entry naming any other fails to compile. */
const ALGORITHMS = new Set([
  'hex64',
  'pemBlock',
  'bip39',
  'envDump',
  'entropy',
  'longVerbatim',
  'projectMarkers',
]);

const EXCERPT_HANDLERS: Record<string, (m: RegExpExecArray) => string> = {
  googleKey: (m) => maskKeeping(m[0], m[0].startsWith('AIza') ? 4 : 7),
  dbConnectionUri: (m) => `${m[1]}://${m[2]}:[redacted]@${m[4]}`,
  bearerToken: (m) => `Authorization: Bearer [redacted ${m[1]?.length ?? 0} chars]`,
  labeledValue: (m) => `${m[1]}=[redacted ${dequote(m[2] ?? '').length} chars]`,
  localPath: localPathExcerpt,
};

const SKIP_HANDLERS: Record<string, (m: RegExpExecArray) => boolean> = {
  exampleDbPassword: (m) => isPlaceholder(m[3] ?? '') || isExamplePassword(m[3] ?? ''),
  placeholderGroup1: (m) => isPlaceholder(m[1] ?? ''),
  nonLiteralValue: skipNonLiteralValue,
  placeholderUsername: (m) => PLACEHOLDER_USERNAME.test(m[1] ?? m[2] ?? ''),
  reservedExampleEmail: (m) => RESERVED_EXAMPLE_DOMAIN.test(m[0]),
};

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

/**
 * Compile the data corpus. Throws rather than degrading: a corpus entry naming a
 * handler this build does not implement is a vendoring mistake, and a scan that
 * silently drops a block-tier detector is worse than one that refuses to start.
 */
function compileLineDetectors(rules: Rule[]): LineDetector[] {
  const out: LineDetector[] = [];
  for (const rule of rules) {
    if (rule.tier !== 'block' && rule.tier !== 'warn') {
      throw new Error(`scan-rules.json: rule ${rule.id} has unknown tier ${rule.tier}`);
    }
    if (rule.match.kind === 'algorithm') {
      if (!ALGORITHMS.has(rule.match.algorithm ?? '')) {
        throw new Error(`scan-rules.json: rule ${rule.id} names unknown algorithm`);
      }
      continue;
    }
    if (rule.match.kind !== 'regex' || rule.match.pattern === undefined) {
      throw new Error(`scan-rules.json: rule ${rule.id} has unknown match kind ${rule.match.kind}`);
    }
    const skip = rule.skip === undefined ? undefined : SKIP_HANDLERS[rule.skip.handler];
    if (rule.skip !== undefined && skip === undefined) {
      throw new Error(`scan-rules.json: rule ${rule.id} names unknown skip ${rule.skip.handler}`);
    }
    out.push({
      check: rule.id,
      severity: rule.tier,
      re: new RegExp(rule.match.pattern, rule.match.flags ?? 'g'),
      excerpt: compileExcerpt(rule),
      skip,
    });
  }
  return out;
}

function compileExcerpt(rule: Rule): (m: RegExpExecArray) => string {
  const policy = rule.excerpt;
  switch (policy.kind) {
    case 'mask': {
      const keep = policy.keep ?? 0;
      return (m) => maskKeeping(m[0], keep);
    }
    case 'verbatim': {
      const max = policy.max;
      return (m) => (max === undefined ? m[0] : truncate(m[0], max));
    }
    case 'abbreviate': {
      const head = policy.head ?? 6;
      const tail = policy.tail ?? 4;
      return (m) => `${m[0].slice(0, head)}…${m[0].slice(-tail)}`;
    }
    case 'custom': {
      const handler = EXCERPT_HANDLERS[policy.handler ?? ''];
      if (handler === undefined) {
        throw new Error(`scan-rules.json: rule ${rule.id} names unknown excerpt handler`);
      }
      return handler;
    }
    default:
      throw new Error(`scan-rules.json: rule ${rule.id} has unknown excerpt kind ${policy.kind}`);
  }
}

const LINE_DETECTORS: LineDetector[] = compileLineDetectors(CORPUS.rules);

function scanLineDetectors(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const detector of LINE_DETECTORS) {
      detector.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = detector.re.exec(line)) !== null) {
        if (!isSuppressedAsDocs(detector, m) && detector.skip?.(m) !== true) {
          out.push({
            check: detector.check,
            severity: detector.severity,
            line: i + 1,
            span: [m.index, m.index + m[0].length],
            excerpt: detector.excerpt(m),
          });
        }
        // Every detector pattern matches at least one character, so a global
        // exec() always advances lastIndex — no zero-width-match loop guard needed.
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suppression: placeholders and reserved example values.
// ---------------------------------------------------------------------------

/**
 * A match that is documentation scaffolding, not a live value: a run of `x`
 * placeholders, an angle/brace template, or a `your…` label. It exists to cut
 * warn fatigue, because `<YOUR_KEY>`-shaped samples are what teach an operator
 * to stop reading findings.
 *
 * TIER ORDERING INVARIANT — this test is a SUBSTRING test over the whole match,
 * so it may only ever suppress a `warn`. A block finding is non-bypassable by
 * contract, and a substring rule hands the bypass to anyone whose secret merely
 * CONTAINS a placeholder shape: real passwords carry `<`, `>`, `{`, `}` and
 * letter runs, so `postgres://app:Str0ng<Pw>Value@prod-db/main` is a live
 * credential, not a docs sample. Block-tier suppression is per-detector only,
 * and is anchored to the captured secret VALUE (isPlaceholder via the
 * `exampleDbPassword` / `placeholderGroup1` handlers), never to a substring of
 * the match. Pinned by "the block tier is non-bypassable" in scan.test.ts.
 */
const DOCS_PLACEHOLDER =
  /x{6,}|<[^<>]*>|\{\{[^{}]*\}\}|\byour[_-]?(?:key|token|secret|password)\b/i;

function isSuppressedAsDocs(detector: LineDetector, m: RegExpExecArray): boolean {
  return detector.severity === 'warn' && DOCS_PLACEHOLDER.test(m[0]);
}

// RFC 2606 reserved second-level domains. The reserved .example TLD is NOT
// included: `alice@corp.example` is the shape a real internal address takes in a
// sanitized draft, and the email detector is a warn the author should still see.
const RESERVED_EXAMPLE_DOMAIN = /@(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)$/i;

// A home-path username that is a docs placeholder, not a real machine username.
const PLACEHOLDER_USERNAME = /^(?:user(?:name)?|you(?:rname)?|example|foo|me|myuser|somebody)$/i;

/**
 * A db-connection-uri already masks the embedded password; the email detector,
 * however, would match `password@host` and echo the password verbatim in its
 * excerpt. Drop any email finding whose span sits inside a db-connection-uri
 * span on the same line so the masking cannot be bypassed.
 */
function suppressEmailsInDbUris(findings: ScanFinding[]): ScanFinding[] {
  const uris = findings.filter((f) => f.check === 'db-connection-uri');
  if (uris.length === 0) return findings;
  return findings.filter(
    (f) =>
      f.check !== 'email' ||
      !uris.some((u) => u.line === f.line && f.span[0] >= u.span[0] && f.span[1] <= u.span[1]),
  );
}

/**
 * Never echo more than a short, non-secret prefix. The kept prefix is a public
 * type marker (`0x`, `AKIA`, `ghp_`, …), never key material; the rest is dropped.
 */
function maskKeeping(match: string, prefixLen: number): string {
  const prefix = match.slice(0, Math.min(prefixLen, match.length));
  return `${prefix}…[redacted ${match.length - prefix.length} chars]`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}…` : value;
}

/**
 * Occurrences of the caller's private project markers (git remote slugs, paths)
 * in the text — warn 'private-repo-reference'. Literal case-insensitive match,
 * compiled once per marker (not per line) and executed against the ORIGINAL
 * line, so spans stay exact (a locale-sensitive toLowerCase can change string
 * length — U+0130 — and misalign them). Token-bounded: `Org/repo`
 * must not fire inside a sibling slug (`Org/repo-docs`, `xOrg/repo`), but a
 * trailing `.` stays allowed so a remote-URL mention (`…/Org/repo.git`) fires.
 * Markers shorter than 3 chars are dropped as degenerate. The excerpt names the
 * matched marker: it is the publisher's own project name, shown locally so they
 * can find and generalize the reference, not key material.
 */
function scanProjectMarkers(lines: string[], markers: string[]): ScanFinding[] {
  const cleaned = [...new Set(markers.filter((m) => m.trim().length >= 3))];
  if (cleaned.length === 0) return [];
  const needles = cleaned.map((marker) => ({
    marker,
    re: new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(marker)}(?![A-Za-z0-9_-])`, 'gi'),
  }));
  const out: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const { marker, re } of needles) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      // Markers are >=3 chars, so every match advances lastIndex — no zero-width guard.
      while ((m = re.exec(line)) !== null) {
        out.push({
          check: 'private-repo-reference',
          severity: 'warn',
          line: i + 1,
          span: [m.index, m.index + m[0].length],
          excerpt: marker,
        });
      }
    }
  }
  return out;
}

/** Escape a literal string for embedding in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localPathExcerpt(m: RegExpExecArray): string {
  // Splice at the capture's own offsets (d-flag indices): a plain
  // String.replace masks the FIRST occurrence of the username, which for a
  // username that is a substring of the /Users|/home prefix mangles the prefix
  // and echoes the real username.
  const bounds = m.indices?.[1] ?? m.indices?.[2];
  const masked =
    bounds === undefined
      ? m[0]
      : `${m[0].slice(0, bounds[0] - m.index)}[user]${m[0].slice(bounds[1] - m.index)}`;
  return truncate(masked, 60);
}

// Accepted gaps (owner call, tracked): a mnemonic laid out in a numbered grid
// (`1. abandon  2. ability` across many short lines) breaks the whitespace-only
// word run bip39 needs and is NOT detected. An all-lowercase, digit-free literal
// that is not a BIP-39 run (a diceware passphrase, e.g.
// PASSWORD=correcthorsebatterystaple) still yields no finding — a dictionary-word
// run is indistinguishable from prose. Headerless base64/DER private keys are
// detected only for OpenSSH (its magic is base64-stable); other DER encodings are not.

/**
 * Shared skip for labeled-value detectors (secret-assignment,
 * customer-identifier — one helper so the two cannot drift): drop a value that
 * is a placeholder, a structural path/URL/regex, or — when UNQUOTED only, a
 * quoted string is a literal — a code expression (config.clientSecret,
 * user.account_id, hashAndSalt(input), a bare lowercase identifier).
 */
function skipNonLiteralValue(m: RegExpExecArray): boolean {
  const raw = m[2] ?? '';
  const value = dequote(raw);
  if (isPlaceholder(value) || isStructural(value)) return true;
  return raw === value && isCodeExpression(value);
}

/** Strip a single matching pair of surrounding quotes from a captured value. */
function dequote(value: string): string {
  const m = /^"([^"]*)"$|^'([^']*)'$/.exec(value);
  return m !== null ? (m[1] ?? m[2] ?? '') : value;
}

// Placeholder tokens must match the WHOLE value, never merely a prefix: an early
// prefix-anchored version let real secrets through (mySecretP@ss123,
// yourCompanyProdKey_abc123, exampleRealKey99) and, because isPlaceholder also
// gates the block-tier bearer/db-uri detectors, that was a block bypass.
const PLACEHOLDER_WORD =
  /^(?:xxx+|example|example-value|placeholder|redacted|changeme|dummy|sample|todo|tbd|none|null|secret|test|\*+|\.{3,})$/i;
// your-/my- style kebab or snake placeholders (your-api-key, my_secret,
// your-key-here) — lowercase words only, so a camelCase/digit-bearing real value
// (yourCompanyProdKey_abc123) is NOT treated as a placeholder.
const PLACEHOLDER_PREFIX = /^(?:your|my)[-_][a-z]+(?:[-_][a-z]+)*$/i;

/** A secret-assignment value that is an obvious placeholder, not a live secret. */
function isPlaceholder(value: string): boolean {
  if (/^[<${%]/.test(value)) return true; // <your-key>, ${VAR}, {{x}}, %ENV%
  return PLACEHOLDER_WORD.test(value) || PLACEHOLDER_PREFIX.test(value);
}

/**
 * A right-hand side that is code, not a literal secret: a member/property access
 * (user.password), a call (hashAndSalt(input)), or a bare lowercase/snake-case
 * identifier reference (password, db_password). Only applied to UNQUOTED values —
 * a quoted string is a literal. camelCase / digit-bearing tokens are NOT code
 * (they read as opaque secrets), so a real value still fires.
 */
function isCodeExpression(value: string): boolean {
  // Trailing code punctuation the value capture drags in (process.env.KEY, ).
  const v = value.replace(/[,;]+$/, '');
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return true; // a.b.c
  if (/^[A-Za-z_$][\w$.]*\([^)]*\)$/.test(v)) return true; // f(...)
  // A call truncated at a quoted arg by the value capture: os.environ.get(
  if (/\($/.test(v)) return true;
  return /^[a-z_$][a-z_$]*$/.test(v); // bare lowercase identifier
}

/** A structural value (path, URL, or regex literal), not a literal secret. */
function isStructural(value: string): boolean {
  return /^(?:\.?\.?\/|~\/|https?:\/\/|\^)/.test(value);
}

// Well-known example/default DB passwords — a connection string using one is a
// docs snippet, not a leaked credential.
const EXAMPLE_PASSWORDS = new Set([
  'password',
  'postgres',
  'mysql',
  'root',
  'admin',
  'changeme',
  'example',
  'secret',
  'test',
  'guest',
  'toor',
]);

/** A db-connection-uri password that is an obvious example/default, not a secret. */
function isExamplePassword(password: string): boolean {
  return EXAMPLE_PASSWORDS.has(password.toLowerCase());
}

// EVM raw private key (0x + 64 hex) vs. a 32-byte public value. On Base the two
// are syntactically identical, and a block finding is permanently
// non-bypassable, so a post quoting a hash, an identifier, or an event topic
// must not be hard-blocked. A 64-hex demotes to the WARN 'hex32-value' when it
// sits inside an http(s) URL token, when a hash/identifier label precedes it, or
// when it is a known public constant. An unlabeled bare 64-hex stays a block
// 'raw-private-key' (continuing the BlockRun-credited wallet-key scanner): that
// is the floor, and demotion never silences, so a real key mislabeled `hash`
// still surfaces for review.
//
// The label window is what a replay over 389 published posts (tenjin#723)
// forced open: every block-tier hit in the live catalog was a public hex
// constant, and each missed the old rule differently — `hash was 0x…` (a word
// between label and value), `source_id = 0x…` (an id-class label), and the
// ERC-20 Transfer topic0 (no label at all). Hence the wider label set, up to TWO
// short intervening tokens, and the constants set. Two is the bound that keeps
// the window honest: "the hash of the private key is 0x…" is four tokens out and
// still blocks.
const HEX64_RE = /(?<![0-9a-fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi;
const HASH_LABEL_RE =
  /(?:^|[^a-z0-9])(?:blockhash|txhash|txn|tx|hash|salt|id|topic\d*|root|digest|commitment)(?:[\s:=/,._-]*[A-Za-z0-9_]{1,12}){0,2}[\s:=/,._-]*$/i;

/** Public 64-hex values that are never key material; see scan-rules.json. */
const PUBLIC_HEX_CONSTANTS = new Set(
  (CORPUS.publicHexConstants ?? []).map((c) => c.value.toLowerCase()),
);

function scanHex64(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    HEX64_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEX64_RE.exec(line)) !== null) {
      const hash = isHashContext(line, m.index, m[0]);
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

/**
 * How far back a label or URL scheme may sit. Bounded so the lookback is O(1)
 * per match rather than a fresh slice of the whole line: a transcript line
 * carrying hundreds of 64-hex values would otherwise be quadratic. A label is
 * relevant within ~40 characters and a scheme+host+path prefix within 256; past
 * that the value stays block, which is the fail-safe direction.
 */
const LABEL_LOOKBACK = 256;

function isHashContext(line: string, matchIndex: number, match: string): boolean {
  if (PUBLIC_HEX_CONSTANTS.has(match.toLowerCase())) return true;
  const from = Math.max(0, matchIndex - LABEL_LOOKBACK);
  const before = line.slice(from, matchIndex);
  // A truncated window must not start mid-word, or `gridhash` cut to `hash`
  // reads as a label. Underscore is kept: it is the boundary `source_id` needs.
  const labelWindow = from === 0 ? before : before.replace(/^[A-Za-z0-9]+/, '');
  if (HASH_LABEL_RE.test(labelWindow)) return true;
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

// ---------------------------------------------------------------------------
// BIP-39 seed phrases — block. A wallet-adjacent CLI that catches a hex key but
// not a mnemonic is not protecting the thing that actually loses the funds.
// ---------------------------------------------------------------------------

const BIP39_WORDS = new Set((wordlistJson as { words: string }).words.split(' '));
/** The shortest valid BIP-39 mnemonic. Below this a run is prose, not a phrase. */
const SEED_PHRASE_MIN_WORDS = 12;

/**
 * A run of >=12 consecutive wordlist words separated ONLY by spaces or tabs.
 * The whitespace-only rule is what keeps prose out: BIP-39 words are common
 * English, but twelve of them in a row with no punctuation is a phrase, not a
 * sentence. Tokens are walked rather than matched by one regex so the span is
 * exact and the pass stays linear on a transcript-length line.
 */
function scanSeedPhrases(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  const token = /\S+/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    token.lastIndex = 0;
    let runStart = -1;
    let runEnd = -1;
    let runWords = 0;
    let m: RegExpExecArray | null;
    const flush = (): void => {
      if (runWords >= SEED_PHRASE_MIN_WORDS) {
        out.push({
          check: 'bip39-seed-phrase',
          severity: 'block',
          line: i + 1,
          span: [runStart, runEnd],
          excerpt: `[redacted ${runWords}-word BIP-39 recovery phrase]`,
        });
      }
      runWords = 0;
    };
    while ((m = token.exec(line)) !== null) {
      if (BIP39_WORDS.has(m[0])) {
        if (runWords === 0) runStart = m.index;
        runEnd = m.index + m[0].length;
        runWords++;
      } else {
        flush();
      }
    }
    flush();
  }
  return out;
}

// ---------------------------------------------------------------------------
// .env dump blocks — warn. One finding per run, naming the KEYS only.
// ---------------------------------------------------------------------------

const ENV_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(\S.*)$/;
/** Three lines is the shortest run that reads as a file rather than one example. */
const ENV_BLOCK_MIN_LINES = 3;
/** A run of short values is configuration (PORT=3000); a long literal is a payload. */
const ENV_SUBSTANTIAL_VALUE = 12;

function scanEnvDumpBlocks(lines: string[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  let i = 0;
  while (i < lines.length) {
    const keys: string[] = [];
    let substantial = false;
    const start = i;
    let m: RegExpExecArray | null;
    while (i < lines.length && (m = ENV_LINE.exec(lines[i] ?? '')) !== null) {
      keys.push(m[1] ?? '');
      const value = dequote((m[2] ?? '').trim());
      if (value.length >= ENV_SUBSTANTIAL_VALUE && !isPlaceholder(value) && !isStructural(value)) {
        substantial = true;
      }
      i++;
    }
    if (keys.length >= ENV_BLOCK_MIN_LINES && substantial) {
      const shown = keys.slice(0, 3).join(', ');
      const rest = keys.length - 3;
      out.push({
        check: 'env-dump-block',
        severity: 'warn',
        line: start + 1,
        span: [0, (lines[start] ?? '').length],
        excerpt: `${keys.length} KEY=VALUE lines (${shown}${rest > 0 ? `, +${rest} more` : ''})`,
      });
    }
    if (i === start) i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generic high-entropy token — warn. The catch-all behind the named shapes.
// ---------------------------------------------------------------------------

// `/` and `=` are deliberately outside the candidate class: with them in, every
// long URL path (`com/BackTrackCo/tenjin-agent/issues/45`) and every
// SHOUTY_KEY=value line reads as one high-entropy token, which is the warn
// fatigue this detector is supposed to avoid causing. The cost is that a
// standard-base64 payload is split on its `/` bytes; the credential families
// that actually carry `/`-bearing base64 (JWT, PEM, OpenSSH) have named detectors.
const ENTROPY_CANDIDATE = /[A-Za-z0-9+_-]{32,}/g;
/** Below this, base62 tokens of this length are not distinguishable from text. */
const MIN_ENTROPY_BITS = 3.5;
/**
 * Random base62 almost never runs more than eight same-case letters; an
 * identifier (getUserProfileByAccountIdentifier) always does. This single test
 * is what keeps long camelCase symbols out of the findings list.
 */
const MAX_SAME_CASE_RUN = 8;

/**
 * Long tokens whose character profile reads as key material. Suppressed when the
 * token overlaps a finding a named detector already produced, so a JWT or an AWS
 * key is reported once, by the detector that knows what it is.
 */
function scanHighEntropy(lines: string[], named: ScanFinding[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    ENTROPY_CANDIDATE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENTROPY_CANDIDATE.exec(line)) !== null) {
      const token = m[0];
      // Warn tier, so the substring placeholder test is allowed here.
      if (!looksRandom(token) || DOCS_PLACEHOLDER.test(token)) continue;
      const span: [number, number] = [m.index, m.index + token.length];
      if (named.some((f) => f.line === i + 1 && f.span[0] < span[1] && span[0] < f.span[1])) {
        continue;
      }
      out.push({
        check: 'high-entropy-string',
        severity: 'warn',
        line: i + 1,
        span,
        excerpt: maskKeeping(token, 4),
      });
    }
  }
  return out;
}

function looksRandom(token: string): boolean {
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (longestSameCaseRun(token) > MAX_SAME_CASE_RUN) return false;
  return shannonBits(token) >= MIN_ENTROPY_BITS;
}

function longestSameCaseRun(token: string): number {
  let best = 0;
  let run = 0;
  let previous = '';
  for (const ch of token) {
    let kind = '';
    if (/[a-z]/.test(ch)) kind = 'lower';
    else if (/[A-Z]/.test(ch)) kind = 'upper';
    if (kind === '') run = 0;
    else run = kind === previous ? run + 1 : 1;
    previous = kind;
    if (run > best) best = run;
  }
  return best;
}

function shannonBits(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
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
  out.push({
    check: 'long-verbatim-quote',
    severity: 'warn',
    line: startLine + 1,
    span: [0, firstLine.length],
    excerpt: truncate(text, 60),
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
