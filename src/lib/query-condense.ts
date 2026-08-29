/**
 * The prompt arm's query shape: identifiers first, then the prompt's own words
 * with the filler out (tenjin-agent#255).
 *
 * A prompt is typed for a person, so most of it is question words, hedges and
 * clauses that carry no topic ("is it failing or will it work tonight and would
 * be fine tomorrow"). Sent whole, that prose outweighs the two or three tokens
 * the shelf could actually match on — a file name, an env-var name, a PR
 * number — and the first 400 characters cut them off entirely when they sat
 * past that. The dirty test behind #255 (bm25.py over the day's recorded
 * prompts) put the team-shelf hit in the top three on 7/7 condensed queries
 * against 1/7 raw ones, and halved the false positives; that came from clause
 * splitting, identifiers-first and the token cap, not from stemming, which is
 * why there is none here (the shelf's `english` config stems its own leg, and
 * the embedding leg wants real words).
 *
 * ONE SOURCE, TWO CALLERS. A hook script cannot import, so the prompt arm
 * carries the block below spliced into its generated source, and the TS
 * exports are built from the SAME TEXT by `new Function` — the precedent is
 * `repoSlugSource` in state-store.ts. There is nothing to drift between.
 *
 * THE IDENTIFIER REGEX IS BOUNDED. The dirty test's pattern had two unbounded
 * `[\w.:/@-]*` classes around a mandatory separator, which is exactly the
 * quadratic shape the scrub's comments in push-scripts.ts measure; this runs
 * between a keypress and the first token, so both classes are capped at 78
 * (an identifier over 158 characters is not one) and the arm runs it AFTER
 * scrub and over at most 4,000 characters.
 */
const QUERY_CONDENSE_JS = String.raw`
// condense:begin
/** Words that carry no topic: articles, auxiliaries, pronouns, question words,
 *  hedges and the pleasantries a prompt opens and closes with. */
const CONDENSE_STOP = new Set(
  (
    'a an the and or but if then else of to in on at by for with from as is are was were be ' +
    'been being it its this that these those i you he she we they me him us them my your our ' +
    'their what which who whom how when where why do does did doing have has had having can ' +
    'could should would will shall may might must not no nor so than too very just also only ' +
    's t don now up out into over under again further here there all any both each few more ' +
    'most other some such own same about above below between through during before after off ' +
    'once ok okay hey hi please pls thanks thx like right yes need want get got make sure still ' +
    'lets let e.g i.e eg ie etc vs'
  ).split(' '),
);
/** A token the shelf can match exactly: a PR or issue reference, a token with
 *  an inner separator or a digit (file names, dotted/slashed/colon-joined
 *  names, versions), CamelCase, or an ALL_CAPS name. Both open classes are
 *  bounded at 78 — see the module comment. */
const CONDENSE_IDENT_RE =
  /(?<![\w/.:#-])(?:#\d{2,}|(?:PR|pr|issue|Issue)\s*#?\d{2,}|[\w][\w.:/@-]{0,78}(?:[_.:/-]|\d)[\w.:/@-]{0,78}[\w]|[A-Z][a-z]+(?:[A-Z][a-z]+)+|[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)(?![\w/.:#-])/g;
/** What the identifier regex matches on shape but nobody means as a handle:
 *  a time or a date (\`05:08\`, \`2026-08-29\`, digits and separators only), a
 *  hyphenated English word (\`follow-up\`, \`re-run\`: lowercase letters joined
 *  by single hyphens; a package name of that shape still travels as prose,
 *  in place) and a dotted abbreviation (\`e.g\`, \`i.e\`). A shelf may AND on
 *  the identifiers list, so a false one there empties the answer. */
const CONDENSE_NOT_IDENT_RE = /^(?:[\d.:/-]+|[a-z]+(?:-[a-z]+)+|(?:[a-z]\.)+[a-z])$/;
const CONDENSE_MAX_IDENTIFIERS = 12;
const CONDENSE_IDENTIFIER_CHARS = 80;
const CONDENSE_MAX_TOKENS = 24;
/** The query's character bound, cut at a whole token; the prompt arm's
 *  PROMPT_QUERY_CHARS is the same figure. Twelve 80-character identifiers
 *  alone would run to 970, and the shelf caps a query at 512. */
const CONDENSE_MAX_CHARS = 400;

/** \`pr-751\` for \`PR 751\`, \`#751\`, \`pr#751\`, \`issue 751\`; null otherwise. */
function condensePrRef(token) {
  const m = /^(?:(?:pr|issue)\s*#?|#)(\d+)$/i.exec(token);
  return m === null ? null : 'pr-' + m[1];
}

/** The identifiers of \`text\` in order: \`{ raw, key }\` per one, where \`raw\` is
 *  the text as typed and \`key\` is the wire spelling (\`pr-751\`, else the raw
 *  text). Deduped case-insensitively on the key, at most 12. */
function condenseIdentifiers(text) {
  const out = [];
  const seen = new Set();
  const matches = String(text).matchAll(CONDENSE_IDENT_RE);
  for (const m of matches) {
    let raw = m[0].replace(/^[.:/-]+|[.:/-]+$/g, '');
    if (raw.length < 3 || raw.length > CONDENSE_IDENTIFIER_CHARS) continue;
    // A bare number is a count, not a handle; a plain lowercase word is prose;
    // so are a time, a date, a hyphenated word and an abbreviation.
    if (/^\d+$/.test(raw) || /^[a-z]+$/.test(raw) || CONDENSE_NOT_IDENT_RE.test(raw)) continue;
    const pr = condensePrRef(raw);
    const key = pr === null ? raw : pr;
    const dedupe = key.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ raw, key });
    if (out.length >= CONDENSE_MAX_IDENTIFIERS) break;
  }
  return out;
}

/** The identifiers list the prompt arm sends beside its query. */
function identifiersOf(text) {
  return condenseIdentifiers(text).map((i) => i.key);
}

/** The condensed query: identifiers as typed, then the prompt's own words in
 *  order with stopwords, one-character tokens, sub-4-word clauses and the
 *  identifiers' own parts dropped, deduped, at most 24 whitespace tokens and
 *  400 characters. A token that would cross the character bound is left out
 *  whole, never cut, and a prose word over 80 characters is not a word. */
function condense(text) {
  const idents = condenseIdentifiers(text);
  const taken = new Set();
  const parts = [];
  let count = 0;
  let chars = 0;
  const fits = (piece) => chars + (chars === 0 ? 0 : 1) + piece.length <= CONDENSE_MAX_CHARS;
  for (const i of idents) {
    // Every whitespace-separated piece of a matched identifier is spoken for
    // (\`PR 751\` is \`PR\` and \`751\` to the word split below).
    for (const piece of i.raw.split(/\s+/)) taken.add(piece.toLowerCase());
    taken.add(i.key.toLowerCase());
    if (!fits(i.raw)) continue;
    parts.push(i.raw);
    count += i.raw.split(/\s+/).length;
    chars += (chars === 0 ? 0 : 1) + i.raw.length;
  }
  const clauses = String(text).split(/[?\n]+/);
  for (const clause of clauses) {
    if (count >= CONDENSE_MAX_TOKENS) break;
    const words = clause.match(/[A-Za-z0-9_./:#-]+/g);
    if (words === null || words.length < 4) continue;
    for (const word of words) {
      if (count >= CONDENSE_MAX_TOKENS) break;
      const w = word.replace(/^[.:/#-]+|[.:/#-]+$/g, '');
      const lower = w.toLowerCase();
      if (lower.length < 2 || lower.length > CONDENSE_IDENTIFIER_CHARS) continue;
      if (CONDENSE_STOP.has(lower) || taken.has(lower)) continue;
      taken.add(lower);
      if (!fits(w)) continue;
      parts.push(w);
      count += 1;
      chars += (chars === 0 ? 0 : 1) + w.length;
    }
  }
  return parts.join(' ');
}
// condense:end
`;

/** The block above, spliced whole into the prompt arm's generated source. */
export function condenseSource(): string {
  return QUERY_CONDENSE_JS;
}

const built = new Function(`${QUERY_CONDENSE_JS}; return { identifiersOf, condense };`)() as {
  identifiersOf: (text: string) => string[];
  condense: (text: string) => string;
};

/** The same function the prompt arm runs, for the CLI and its tests. */
export const identifiersOf: (text: string) => string[] = built.identifiersOf;
/** The same function the prompt arm runs, for the CLI and its tests. */
export const condense: (text: string) => string = built.condense;
