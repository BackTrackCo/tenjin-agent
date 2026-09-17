# Leak check — agent-262-273-condense

## The shared fact, quoted from the producer's merge commit (93263c5)

`src/lib/query-condense.ts` is ONE JavaScript source string, delimited by marker comments,
that is both spliced into the generated hook and evaluated to produce the package's own
exports. Lines 29-33, 58-64, 97, 106, 143, 147, 157-159:

```ts
const QUERY_CONDENSE_JS = String.raw`
// condense:begin
...
const CONDENSE_MAX_IDENTIFIERS = 12;
const CONDENSE_IDENTIFIER_CHARS = 80;
const CONDENSE_MAX_TOKENS = 24;
const CONDENSE_MAX_CHARS = 400;
function identifiersOf(text) { ... }
function condense(text) { ... }
// condense:end
`;
export function condenseSource(): string { ... }
export const identifiersOf: (text: string) => string[] = built.identifiersOf;
export const condense: (text: string) => string = built.condense;
```

`src/lib/push-scripts.ts:1441-1444` — the prompt arm's pipeline ORDER:

```js
const identifiers = identifiersOf(scrubbed);
const condensed = condense(scrubbed);
// query = condensed.length > 0 ? condensed : scrubbed.slice(0, PROMPT_QUERY_CHARS)
```

`src/lib/push-scripts.ts:1267` — `function scrub(text) {`, a single-argument function that
the test suite locates inside the GENERATED script by that exact signature string.
`src/lib/hook-scripts.ts:182-183` — the wire field is `identifiers`, capped at 12 entries
of 80 characters. `src/lib/push-scripts.ts:867` — `identifiers: args.identifiers` inside
`shelfAsk`, so BOTH shelves receive it.

## Why the consumer needs it

`src/lib/push-scripts.test.ts` at the consumer's merge commit (33e8ec6):

- line 1628 — `const fn = source.indexOf('function scrub(text, mode)');`. The consumer must
  change the signature AND preserve the extract-by-signature-string convention. An agent
  that adds the mode as an options object, a second exported function, or a default
  parameter spelled differently fails here with an opaque "scrub block not found".
- lines 1603-1616 — the generated hook body must still equal `condenseSource()` between
  `// condense:begin` and `// condense:end`, and `new Function(body)` must yield a
  `condense` and an `identifiersOf` that agree with the exported ones.
- lines 2024-2035 — the security case, verbatim from the file: *"#262's condense pipeline
  runs identifiersOf()/condense() straight over whatever scrub() returns... it cannot ride
  either the condensed `query` string or the `identifiers` array it is built from."* The
  test is `keeps an sk-style key out of both the condensed query and the identifiers array`.
- line 1841 — `sends the condensed query and the identifiers list on the wire`.

Loosening the sanitizer without knowing that the identifier extractor runs downstream of it
produces a credential that is absent from the query and present in the identifier array.
That is the trap, and it is a security failure, not a cosmetic one.

## The consumer prompt does not contain it

```
grep -icE "condense|identifiersOf|identifiers|condenseSource|query-condense|scrub\(text|secretsOnly|push-scripts|hook-scripts" prompts/agent-262-273-condense-consumer.md
```

returns **0**. The prompt says "one arm assembles its query out of more than one piece of
text, so make sure the guard reads the assembled result". It names no module, no function,
no field, no marker, and no cap.

## Partial leak in the ORACLE, not the prompt

`src/lib/push-scripts.test.ts` at the consumer commit imports
`{ condense, condenseSource, identifiersOf } from './query-condense'` at line 58 — but
that import is already present in the file at the consumer's BASE commit, because the
producer's tests put it there. Running the oracle adds nothing the base tree does not
already show. No new leak. Flagged as clean.
