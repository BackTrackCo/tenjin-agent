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
    ...scanLongVerbatim(lines),
    ...scanProjectMarkers(lines, context.projectMarkers ?? []),
  ];
  return dedupeAndSort(suppressEmailsInDbUris(findings));
}

/**
 * Occurrences of the caller's private project markers (git remote slugs, paths)
 * in the text — warn 'private-repo-reference'. Literal case-insensitive match,
 * compiled once per marker (not per line) and executed against the ORIGINAL
 * line, so spans stay exact (a locale-sensitive toLowerCase can change string
 * length — U+0130 — and misalign them; review r5). Token-bounded: `Org/repo`
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
    // gitleaks openai-api-key: classic sk- plus the modern sk-proj-/sk-svcacct-/
    // sk-admin- keys. The body is base62 and MUST contain a digit (real keys are
    // high-entropy), which keeps sk- kebab identifiers (sk-user-profile-updated…)
    // from hard-blocking. `(?!ant-)` keeps an Anthropic key out. Only the base62
    // leading run of a modern key is matched — enough to flag it. The run is
    // terminated by a non-base62 lookahead (not \b, which a trailing `_` — a word
    // char — would not fire), so an underscore-adjacent key still matches.
    // Assumption + chosen tradeoff: a real key opens with a >=20-char base62 run,
    // so the {20,} floor is what separates a key from a kebab identifier. A key
    // whose FIRST segment is shorter than 20 (e.g. `sk-proj-abc123_` then more,
    // broken up by underscores) slips past this BARE-PASTE detector; that is
    // accepted, because such a value in an assignment still warns via
    // secret-assignment — the bare-paste path is the only gap.
    re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?(?=[0-9A-Za-z]*[0-9])[0-9A-Za-z]{20,}(?![0-9A-Za-z])/g,
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
    // rest so the finding is legible. Placeholder-gated like the other high-
    // confidence shapes so a docs example (postgres://postgres:postgres@…,
    // ://user:<password>@…) doesn't hard-block; a real password still blocks.
    re: /\b([a-z][a-z0-9+.-]*):\/\/([^\s:@/]+):([^\s@/]+)@([^\s/:]+)/gi,
    excerpt: (m) => `${m[1]}://${m[2]}:[redacted]@${m[4]}`,
    skip: (m) => isPlaceholder(m[3] ?? '') || isExamplePassword(m[3] ?? ''),
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
  // lower-confidence than a structured shape, and a warn still forces confirmation
  // in auto mode (and review always asks), so nothing publishes unseen while benign
  // config (SECRET_NAME=…, MYSQL_ROOT_PASSWORD=…) is not permanently non-bypassable. The
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
    skip: skipNonLiteralValue,
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
  // Employer-internal markers — warn. Marker-SHAPED, not word-in-phrase (#36):
  // the detector targets the classification legend a document stamp carries
  // (CONFIDENTIAL, CONFIDENTIAL DRAFT/INFORMATION, STRICTLY/COMPANY
  // CONFIDENTIAL, "Acme Inc. Confidential", INTERNAL (USE) ONLY, DO NOT
  // DISTRIBUTE), so it is case-SENSITIVE — prose about "confidential computing"
  // never fires. The phrase-vs-legend split is positional, not a blanket
  // next-word lookahead (review r5: the old lookahead lost CONFIDENTIAL
  // INFORMATION and every title-case legend):
  //  - all-caps CONFIDENTIAL is suppressed only when all-caps words flank it on
  //    BOTH sides — that is what a mid-phrase mention in a shouting heading
  //    looks like (A SURVEY OF CONFIDENTIAL COMPUTING …). A legend either leads
  //    its line (CONFIDENTIAL DRAFT) or ends it (ACME CONFIDENTIAL, HIGHLY
  //    CONFIDENTIAL, PROPRIETARY AND CONFIDENTIAL), so one-sided caps still
  //    fire (review r6: the caps-prefixed company stamp is the most common real
  //    legend form, and the old left-only rule missed the whole family).
  //    Accepted FP: a caps heading that LEADS with the topic word
  //    (# CONFIDENTIAL COMPUTING ON AWS) warns — fail-safe direction. Accepted
  //    FN: a caps-flanked legend without a whitelisted prefix (ACME
  //    CONFIDENTIAL INFORMATION) is indistinguishable from a shouting-heading
  //    phrase and misses; STRICTLY/COMPANY/HIGHLY prefixes are legend-only
  //    vocabulary and are whitelisted through.
  //  - Title-case Confidential fires only before punctuation or end-of-line
  //    ("Acme Inc. Confidential", "## Confidential: …"), never mid-title
  //    ("Confidential Computing: a TEE survey").
  {
    check: 'confidential-marker',
    severity: 'warn',
    re: /\b(?:STRICTLY|COMPANY|HIGHLY)\s+CONFIDENTIAL\b|(?<![A-Z]{2,}[ \t]+)\bCONFIDENTIAL\b|\bCONFIDENTIAL\b(?![ \t]+[A-Z]{2,})|\bConfidential(?=\s*(?:[-:.,;–—]|$))|\b(?:INTERNAL|Internal)(?:\s+(?:USE|Use))?\s+(?:ONLY|Only)\b|\b(?:DO\s+NOT\s+DISTRIBUTE|Do\s+Not\s+Distribute)\b/g,
    excerpt: (m) => m[0],
  },
  {
    check: 'internal-hostname',
    severity: 'warn',
    re: /\b(?:[a-z0-9-]+\.)+(?:internal|corp|local|lan|intranet)\b/gi,
    excerpt: (m) => m[0],
  },
  // Home-anchored local filesystem paths — warn (open-questions publishing-safety:
  // private paths). A /Users/<name>/… or /home/<name>/… or C:\Users\<name>\…
  // path leaks the machine username and private project layout. The username
  // segment is masked in the excerpt; obvious placeholder usernames
  // (/home/user/…, /Users/username/…) are docs examples and skip. `~/…` paths
  // deliberately do NOT fire: they are already generalized. The unix branch
  // requires a non-name left boundary so a web-URL path segment
  // (docs.example.com/home/…) is not a local path, and the segment class
  // excludes `?`/`&` so a query string (…?api_key=…) is never swallowed into a
  // verbatim excerpt a sibling detector would have masked (review r5). Windows
  // matches [Uu]sers: the filesystem is case-insensitive.
  {
    check: 'local-path',
    severity: 'warn',
    re: /(?:(?<![\w.-])\/(?:Users|home)\/([A-Za-z0-9._-]+)(?:\/[^\s"'`)\]}>:,;?&]+)+|\b[A-Za-z]:\\[Uu]sers\\([^\\\s"']+)(?:\\[^\\\s"']+)+)/dg,
    excerpt: (m) => {
      // Splice at the capture's own offsets (d-flag indices): a plain
      // String.replace masked the FIRST occurrence of the username, which for a
      // username that is a substring of the /Users|/home prefix mangled the
      // prefix and echoed the real username (review r5).
      const bounds = m.indices?.[1] ?? m.indices?.[2];
      const masked =
        bounds === undefined
          ? m[0]
          : `${m[0].slice(0, bounds[0] - m.index)}[user]${m[0].slice(bounds[1] - m.index)}`;
      return masked.length > 60 ? `${masked.slice(0, 57)}…` : masked;
    },
    skip: (m) => PLACEHOLDER_USERNAME.test(m[1] ?? m[2] ?? ''),
  },
  // Labeled customer/account identifiers — warn (open-questions publishing-safety:
  // customer identifiers). Fires only on the explicit label + separator + value
  // shape (customer_id: 84213, Account Number: ACME-0042); the value is masked
  // like a secret-assignment value since a customer identifier is third-party
  // data. Chosen tradeoff: an unlabeled identifier (bare CUST-4812) is a false
  // negative — an unlabeled token is indistinguishable from a SKU or version tag.
  {
    check: 'customer-identifier',
    severity: 'warn',
    re: /\b((?:customer|client|account|tenant|subscriber)[ _-]?(?:id|number|no))\b\s*[:=#]\s*("[^"]{2,}"|'[^']{2,}'|[A-Za-z0-9][A-Za-z0-9._-]{2,})/gi,
    excerpt: (m) => `${m[1]}=[redacted ${dequote(m[2] ?? '').length} chars]`,
    skip: skipNonLiteralValue,
  },
  // Third-party paid/licensed-content markers — warn (open-questions
  // publishing-safety: third-party copyrighted inputs). A rights LEGEND in the
  // draft suggests copied licensed material; ambiguity-class (the author may
  // hold the rights), so warn, never block. Legend shapes only — bare paywall
  // vocabulary (paywalled, premium content, subscriber-only, behind a paywall)
  // deliberately does NOT fire: it is this marketplace's own subject matter and
  // measured 100% false-positive on the dogfood corpus (review r5), the exact
  // word-in-phrase failure #36 is about.
  {
    check: 'paid-content-marker',
    severity: 'warn',
    re: /\ball rights reserved\b|\b(?:reprinted|reproduced|used) with permission\b|\bnot for (?:redistribution|republication)\b|\bdo not (?:redistribute|republish)\b|(?:©|\(c\)|copyright)\s*(?:19|20)\d{2}\b/gi,
    excerpt: (m) => m[0],
  },
  // Embedded prompt/tool-output instruction patterns — warn (open-questions
  // publishing-safety: embedded instructions). Source material captured from
  // prompts or tool output can carry injection-shaped imperatives that would
  // ship to every future buyer. High-precision imperative shapes only: a bare
  // "system prompt" mention, chat-template delimiters (<system>, [INST]), and
  // persona phrases ("you are an assistant", "as an AI") deliberately do NOT
  // fire — legitimate agent-engineering exposition quotes all of them
  // constantly (review r5), and only the imperative shapes are injection-typed.
  {
    check: 'embedded-instruction',
    severity: 'warn',
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|context|messages?)\b|\bBEGIN (?:SYSTEM|HIDDEN) (?:PROMPT|INSTRUCTIONS)\b|\bdo not (?:reveal|disclose|mention) (?:this|these|the above)\b/gi,
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
        if (!detector.skip?.(m)) {
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

// Accepted alpha gaps (owner call, tracked for post-alpha): BIP-39 mnemonic
// phrases (12/24 dictionary words) are NOT detected — a wordlist match is
// high-false-positive against prose and deferred. An all-lowercase, digit-free
// literal (a diceware/xkcd passphrase, e.g. PASSWORD=correcthorsebatterystaple)
// parses as a bare identifier and yields NO finding for the same reason — a
// dictionary-word run is indistinguishable from prose; chosen, warn-tier, and
// filed next to BIP-39. Headerless base64/DER-encoded private keys (no
// -----BEGIN----- marker) are likewise NOT detected; only the PEM-armored form
// and the 0x-64-hex form are.

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
