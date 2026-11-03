/**
 * The one redaction module: what text may leave this machine in a hook query or
 * a router packet is decided by one rule table (`redact-rules.json`) through
 * this file.
 *
 * `mask(text)` replaces each match of a row with that row's excerpt
 * (`ghp_…[redacted 36 chars]`, `postgres://app:[redacted]@host`,
 * `PGPASSWORD=[redacted 7 chars]`, `0x…[redacted 64 chars]`) and touches
 * nothing else. The regex rows run first, then the hex-key, PEM and
 * seed-phrase algorithms. Precision first, the way gitleaks and GitHub push
 * protection work: a vendor prefix fires on format alone, the generic
 * assignment rule needs a secret-named word plus `=` or `:`, and entropy is
 * never a trigger. Paths, hosts, IPs, commit SHAs, env names and prose are
 * never touched (owner policy, tenjin-agent#197 and the 2026-09-04 decision in
 * tenjin-notes/loop-redesign/06-pr-a-redact.md: search availability over
 * scrubbing; measured, the old scrub altered 16% of real prompts to stop two
 * vendor tokens).
 *
 * Two invariants, pinned by redact.fixtures.test.ts and redact.test.ts:
 *
 * REDACTION: an excerpt is a type-identifying prefix plus a redaction count,
 * never the matched secret. A PEM block keeps its armor header.
 *
 * ReDoS: no pattern may contain a quantified group whose body can also match the
 * group's own separator while a further obligation follows it. Audited against a
 * single line of hundreds of kilobytes, the shape a JSONL transcript record takes.
 *
 * The rule corpus lives as DATA in `redact-rules.json`; this file compiles that
 * data and implements the handlers and algorithmic detectors it names.
 * Per-rule attribution is in the data file's `source` field and in NOTICE.md.
 * No pattern set is a runtime dependency: this is a wallet-holding CLI, kept
 * offline with a tight dep tree by design.
 */

import { createHash } from 'node:crypto';
import corpusJson from './redact-rules.json';
import wordlistJson from './bip39-wordlist.json';

/** One algorithmic match: where it sits on its line and what replaces it. */
interface MaskSpan {
  /** The detector that matched, e.g. "raw-private-key". */
  check: string;
  /** [startColumn, endColumn) within the line, 0-based. */
  span: [number, number];
  /** What replaces the match: masked, never the secret. */
  excerpt: string;
}

/**
 * Replace every match of a row with that row's masked excerpt. Nothing else
 * changes: no deletion, no squash, no bound. A `skip` handler leaves its
 * match as written, so a placeholder or a `$VAR` value stays.
 */
export function mask(text: string): string {
  // C0 bytes are deleted first (whitespace kept): a control byte inside a name
  // is a splitter, `api_key<0x01>=hunter2` reads as two tokens to every row
  // below, and the hooks' clean() only removes it after the mask has decided.
  // eslint-disable-next-line no-control-regex
  let out = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Table order is mask order: the assignment row is first so a value that is
  // itself a vendor token is taken whole, name kept, and no later row sees a
  // stub to re-match.
  for (const detector of MASK_DETECTORS) {
    out = out.replace(detector.re, (...args: unknown[]) => {
      // replace() hands (match, ...groups, offset, input[, named groups]).
      // Rebuilt as an exec array so a skip can read the text around its match.
      const tail = typeof args.at(-1) === 'object' ? 3 : 2;
      const m = Object.assign(args.slice(0, -tail), {
        index: args.at(-tail) as number,
        input: args.at(-tail + 1) as string,
      }) as unknown as RegExpExecArray;
      return detector.skip?.(m) === true ? m[0] : detector.excerpt(m);
    });
  }
  // The algorithm rows after the regex pass. A value the regex pass already
  // masked no longer matches.
  out = out.split('\n').map(maskLineSpans).join('\n');
  out = maskLooseMnemonics(out);
  return maskPemBlocks(out);
}

/**
 * One line's hex-key and seed-phrase spans, each replaced by its excerpt.
 * Built in one left-to-right pass rather than a splice per span: a transcript
 * line can carry thousands of keys. A 64-hex in hash context is not a key, and
 * stays as written.
 *
 * A wordlist run longer than the longest recovery phrase is not masked here:
 * a run of common words that long is text a routing decision reads (a repeated
 * word, a pasted list). {@link maskLooseMnemonics} masks any phrase inside it.
 */
function maskLineSpans(line: string): string {
  const lines = [line];
  const spans = [...scanHex64(lines), ...scanSeedPhrases(lines)]
    .filter(
      (f) =>
        f.check !== 'bip39-seed-phrase' ||
        line.slice(f.span[0], f.span[1]).split(/[\s"'`]+/).length <= SEED_PHRASE_MAX_WORDS,
    )
    .sort((a, b) => a.span[0] - b.span[0]);
  if (spans.length === 0) return line;
  const parts: string[] = [];
  let cursor = 0;
  for (const f of spans) {
    if (f.span[0] < cursor) continue;
    parts.push(line.slice(cursor, f.span[0]), f.excerpt);
    cursor = f.span[1];
  }
  parts.push(line.slice(cursor));
  return parts.join('');
}

/**
 * A PEM private key from its BEGIN marker through its END marker, or to the
 * end of the text when the paste has no END line. The armor header is kept as
 * the type marker; everything after it is key material and goes.
 */
function maskPemBlocks(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const begin = PEM_BEGIN.exec(rest);
    if (begin === null) return out + rest;
    const body = begin.index + begin[0].length;
    const end = PEM_END.exec(rest.slice(body));
    const stop = end === null ? rest.length : body + end.index + end[0].length;
    out += rest.slice(0, begin.index) + maskKeeping(rest.slice(begin.index, stop), begin[0].length);
    rest = rest.slice(stop);
  }
}

// ---------------------------------------------------------------------------
// Rule corpus: redact-rules.json compiled into executable detectors.
// ---------------------------------------------------------------------------

interface RuleExcerpt {
  kind: string;
  keep?: number;
  handler?: string;
}

interface Rule {
  id: string;
  tier: string;
  description: string;
  source: string;
  match: { kind: string; pattern?: string; flags?: string; algorithm?: string };
  excerpt: RuleExcerpt;
  /** Leave the match as written (e.g. a placeholder value). */
  skip?: { handler: string };
}

const CORPUS = corpusJson as unknown as {
  schemaVersion: number;
  rules: Rule[];
  publicHexConstants?: Array<{ value: string; name: string }>;
};

/** Algorithmic detectors this file implements; a corpus entry naming any other fails to compile. */
const ALGORITHMS: ReadonlySet<string> = new Set(['hex64', 'pemBlock', 'bip39']);

const EXCERPT_HANDLERS: Record<string, (m: RegExpExecArray) => string> = {
  googleKey: (m) => maskKeeping(m[0], m[0].startsWith('AIza') ? 4 : 7),
  dbConnectionUri: (m) => `${m[1]}://${m[2]}:[redacted]@${m[4]}`,
  bearerToken: (m) => `Authorization: Bearer [redacted ${m[1]?.length ?? 0} chars]`,
  labeledValue: (m) => `${m[1]}=[redacted ${dequote(m[2] ?? '').length} chars]`,
};

const SKIP_HANDLERS: Record<string, (m: RegExpExecArray) => boolean> = {
  exampleDbPassword: (m) => isPlaceholder(m[3] ?? '') || isExamplePassword(m[3] ?? ''),
  placeholderGroup1: (m) => isPlaceholder(m[1] ?? ''),
  nonLiteralValue: skipNonLiteralValue,
  hashLabelled: isLabelledHash,
};

interface LineDetector {
  /** Global regex. */
  re: RegExp;
  /** Build the masked excerpt from a single match. */
  excerpt: (m: RegExpExecArray) => string;
  /** Leave this match as written (e.g. a placeholder value). */
  skip?: (m: RegExpExecArray) => boolean;
}

function validateTier(rule: Rule): void {
  if (rule.tier !== 'block' && rule.tier !== 'warn') {
    throw new Error(`redact-rules.json: rule ${rule.id} has unknown tier ${String(rule.tier)}`);
  }
}

function compileSkip(rule: Rule): ((m: RegExpExecArray) => boolean) | undefined {
  const skip = rule.skip === undefined ? undefined : SKIP_HANDLERS[rule.skip.handler];
  if (rule.skip !== undefined && skip === undefined) {
    throw new Error(`redact-rules.json: rule ${rule.id} names unknown skip ${rule.skip.handler}`);
  }
  return skip;
}

function compileRegex(rule: Rule): RegExp {
  if (rule.match.kind !== 'regex' || rule.match.pattern === undefined) {
    throw new Error(`redact-rules.json: rule ${rule.id} has unknown match kind ${rule.match.kind}`);
  }
  return new RegExp(rule.match.pattern, rule.match.flags ?? 'g');
}

function compileLineDetectors(rules: Rule[]): LineDetector[] {
  const out: LineDetector[] = [];
  for (const rule of rules) {
    if (rule.match.kind === 'algorithm') continue;
    out.push({ re: compileRegex(rule), excerpt: compileExcerpt(rule), skip: compileSkip(rule) });
  }
  return out;
}

/**
 * Validate every row once, at load. Throws rather than degrading: a corpus
 * entry naming a handler this build does not implement is a mistake, and a
 * mask that silently drops a detector is worse than one that refuses to start.
 */
function validateCorpus(rules: Rule[]): void {
  for (const rule of rules) {
    validateTier(rule);
    if (rule.match.kind === 'algorithm') {
      if (!ALGORITHMS.has(rule.match.algorithm ?? '')) {
        throw new Error(`redact-rules.json: rule ${rule.id} names unknown algorithm`);
      }
      continue;
    }
    compileRegex(rule);
  }
  // The converse: every algorithm this file implements has exactly one row, so
  // the table, not this file, is the record of what mask() applies.
  for (const algorithm of ALGORITHMS) {
    const rows = rules.filter(
      (r) => r.match.kind === 'algorithm' && r.match.algorithm === algorithm,
    );
    if (rows.length !== 1) {
      throw new Error(
        `redact-rules.json: algorithm ${algorithm} has ${rows.length} rows, needs exactly one`,
      );
    }
  }
}

function compileExcerpt(rule: Rule): (m: RegExpExecArray) => string {
  const policy = rule.excerpt;
  switch (policy.kind) {
    case 'mask': {
      const keep = policy.keep ?? 0;
      return (m) => maskKeeping(m[0], keep);
    }
    case 'custom': {
      const handler = EXCERPT_HANDLERS[policy.handler ?? ''];
      if (handler === undefined) {
        throw new Error(`redact-rules.json: rule ${rule.id} names unknown excerpt handler`);
      }
      return handler;
    }
    default:
      throw new Error(`redact-rules.json: rule ${rule.id} has unknown excerpt kind ${policy.kind}`);
  }
}

validateCorpus(CORPUS.rules);
const MASK_DETECTORS: LineDetector[] = compileLineDetectors(CORPUS.rules);

/**
 * Never echo more than a short, non-secret prefix. The kept prefix is a public
 * type marker (`0x`, `AKIA`, `ghp_`, …), never key material; the rest is dropped.
 */
function maskKeeping(match: string, prefixLen: number): string {
  const prefix = match.slice(0, Math.min(prefixLen, match.length));
  return `${prefix}…[redacted ${match.length - prefix.length} chars]`;
}

// ---------------------------------------------------------------------------
// Suppression: placeholders and example values.
// ---------------------------------------------------------------------------

// Accepted gaps (owner call, tracked): a mnemonic laid out in a numbered grid
// (`1. abandon  2. ability` across many short lines) breaks the whitespace-only
// word run bip39 needs and is NOT detected. An all-lowercase, digit-free literal
// that is not a BIP-39 run (a diceware passphrase, e.g.
// PASSWORD=correcthorsebatterystaple) is not masked — a dictionary-word
// run is indistinguishable from prose. Headerless base64/DER private keys are
// detected only for OpenSSH (its magic is base64-stable); other DER encodings are not.

/**
 * Shared skip for labeled-value detectors (secret-assignment,
 * curl-user-credential — one helper so the two cannot drift): keep a value that
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
// gates the bearer and db-uri rows, a bypass of those too.
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
// are syntactically identical, and a question quoting a hash, an identifier or
// an event topic must keep it. A 64-hex stays as written when it sits inside an
// http(s) URL token, when a hash/identifier label precedes it, or when it is a
// known public constant. An unlabeled bare 64-hex is masked as a
// 'raw-private-key' (continuing the BlockRun-credited wallet-key scanner): that
// is the floor.
//
// The label window is what a replay over 389 published posts (tenjin#723)
// forced open: every key-shaped hit in the live catalog was a public hex
// constant, and each missed the old rule differently — `hash was 0x…` (a word
// between label and value), `source_id = 0x…` (an id-class label), and the
// ERC-20 Transfer topic0 (no label at all). Hence the wider label set, up to TWO
// short intervening tokens, and the constants set. Two is the bound that keeps
// the window honest: "the hash of the private key is 0x…" is four tokens out and
// still masks. The replay's last survivor was markdown: the catalog writes
// ``hash was `0x…` ``, so the separator class carries backticks and quotes.
//
// Only the SEPARATOR classes are permissive. What counts as a LABEL is closed,
// which is why `` PRIVATE_KEY=`0x…` `` still masks: no punctuation tolerance
// can invent a label that is not in the set.
const HEX64_RE = /(?<![0-9a-fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi;
const HASH_LABEL_RE =
  /(?:^|[^a-z0-9])(?:blockhash|txhash|txn|tx|hash|salt|id|topic\d*|root|digest|commitment)(?:[\s:=/,._'"`‘’“”-]*[A-Za-z0-9_]{1,12}){0,2}[\s:=/,._'"`‘’“”-]*$/i;

/** Public 64-hex values that are never key material; see redact-rules.json. */
const PUBLIC_HEX_CONSTANTS = new Set(
  (CORPUS.publicHexConstants ?? []).map((c) => c.value.toLowerCase()),
);

function scanHex64(lines: string[]): MaskSpan[] {
  const out: MaskSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    HEX64_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEX64_RE.exec(line)) !== null) {
      if (isHashContext(line, m.index, m[0])) continue;
      out.push({
        check: 'raw-private-key',
        span: [m.index, m.index + m[0].length],
        excerpt: maskKeeping(m[0], 2),
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
 * that the value is masked, which is the fail-safe direction.
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

/** The hash labels that keep a bare 64-hex or an 88-character base58 run as written. */
const BARE_HASH_LABEL_RE =
  /(?:^|[^a-z0-9])(?:tx|txn|txid|hash|sha\d*|hmac|digest|commit|id|checksum|sig|signature)(?:[\s:=/,._*'"`‘’“”-]*[A-Za-z0-9_]{1,12}){0,2}[\s:=/,._*'"`‘’“”-]*$/i;

/**
 * A bare key-shaped run that is a hash or a signature by context: a hash label
 * within two tokens before it, or an http(s) URL it sits inside. The same
 * window and URL test the 0x form's hash reading uses, with the labels a bare
 * digest or a Solana signature carries.
 */
function isLabelledHash(m: RegExpExecArray): boolean {
  const input = m.input;
  const from = Math.max(0, m.index - LABEL_LOOKBACK);
  const before = input.slice(from, m.index);
  const labelWindow = from === 0 ? before : before.replace(/^[A-Za-z0-9]+/, '');
  if (BARE_HASH_LABEL_RE.test(labelWindow)) return true;
  const prefix = /(\S*)$/.exec(before)?.[1] ?? '';
  return /^https?:\/\//.test(input.slice(m.index - prefix.length));
}

// gitleaks private-key marker (RSA/EC/OPENSSH/PGP variants, optional BLOCK).
const PEM_BEGIN = /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/;

// ---------------------------------------------------------------------------
// BIP-39 seed phrases. A wallet-adjacent CLI that catches a hex key but
// not a mnemonic is not protecting the thing that actually loses the funds.
// ---------------------------------------------------------------------------

const BIP39_WORDS = new Set((wordlistJson as { words: string }).words.split(' '));
/** The shortest valid BIP-39 mnemonic. Below this a run is prose, not a phrase. */
const SEED_PHRASE_MIN_WORDS = 12;
/** The longest BIP-39 mnemonic. */
const SEED_PHRASE_MAX_WORDS = 24;
const SEED_PHRASE_SIZES = [24, 21, 18, 15, 12];
const BIP39_INDEX = new Map(
  (wordlistJson as { words: string }).words.split(' ').map((word, index) => [word, index]),
);

/** What may sit between two words of a loosely written phrase. */
const LOOSE_SEPARATOR = /^[\s,"'`]+$/;

/**
 * Recovery phrases the strict line scan does not see: any case, words joined
 * by commas, quotes or line breaks (a 6+6 paste), or a phrase inside a longer
 * wordlist run. Only a window that IS a phrase goes, 12 to 24 words whose
 * BIP-39 checksum holds, longest first; everything else stays as written, so
 * a capitalized or comma-separated list of common words is not a false hit.
 * The English wordlist is the only one this build ships.
 */
function maskLooseMnemonics(text: string): string {
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((m) => ({
    word: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
  // A long run repeats itself (a word typed over and over), so each distinct
  // window is hashed once: the pass stays linear on a transcript-length text.
  const checked = new Map<string, boolean>();
  const valid = (window: string[]): boolean => {
    const key = window.join(' ');
    let result = checked.get(key);
    if (result === undefined) checked.set(key, (result = isMnemonic(window)));
    return result;
  };
  const parts: string[] = [];
  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    while (
      j < tokens.length &&
      BIP39_INDEX.has(tokens[j]!.word) &&
      (j === i || LOOSE_SEPARATOR.test(text.slice(tokens[j - 1]!.end, tokens[j]!.start)))
    ) {
      j++;
    }
    if (j === i) {
      i++;
      continue;
    }
    let k = i;
    while (k + SEED_PHRASE_MIN_WORDS <= j) {
      const size = SEED_PHRASE_SIZES.find(
        (n) => k + n <= j && valid(tokens.slice(k, k + n).map((t) => t.word)),
      );
      if (size === undefined) {
        k++;
        continue;
      }
      parts.push(
        text.slice(cursor, tokens[k]!.start),
        `[redacted ${size}-word BIP-39 recovery phrase]`,
      );
      cursor = tokens[k + size - 1]!.end;
      k += size;
    }
    i = j;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/** BIP-39: 11 bits per word, the last `n / 3` of them a SHA-256 checksum of the rest. */
function isMnemonic(words: string[]): boolean {
  let bits = 0n;
  for (const word of words) bits = (bits << 11n) | BigInt(BIP39_INDEX.get(word) ?? 0);
  const checksumBits = BigInt(words.length / 3);
  const entropyBytes = (words.length * 11 - words.length / 3) / 8;
  const entropy = Buffer.from(
    (bits >> checksumBits).toString(16).padStart(entropyBytes * 2, '0'),
    'hex',
  );
  const expected = BigInt(createHash('sha256').update(entropy).digest()[0]!) >> (8n - checksumBits);
  return (bits & ((1n << checksumBits) - 1n)) === expected;
}

/**
 * A run of >=12 consecutive wordlist words separated ONLY by whitespace or
 * quote characters. The rule is what keeps prose out: BIP-39 words are common
 * English, but twelve of them in a row with no punctuation is a phrase, not a
 * sentence. A quote is a separator so the `.env` form counts:
 * `MNEMONIC="abandon … about"` (tenjin-agent#296). Tokens are walked rather
 * than matched by one regex so the span is exact and the pass stays linear on
 * a transcript-length line.
 */
function scanSeedPhrases(lines: string[]): MaskSpan[] {
  const out: MaskSpan[] = [];
  const token = /[^\s"'`]+/g;
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
