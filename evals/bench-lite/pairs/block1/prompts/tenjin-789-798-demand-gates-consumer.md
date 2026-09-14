# Close the last two gaps in the demand count

Two holes are left in the headline demand number. The first is that only one of the two halves
the number unions ever applies an operator veto at all, so a term an operator hid from the term
lists still inflates the total from the other side. The second is that neither half applies the
question-shape rule the question lists use, so a canonical test string or a question with no
letters in it counts as real agent demand. Fix both, and build the shape rule's database form off
the same pattern source the TypeScript one uses rather than retyping it, since two hand-written
copies of one rule are how they drift.

## Contract

The observable interface the tests assert. Implementation is yours.

**The catalog half's veto**

- The catalog half of `getAgentSearchDemandSummary(db, { days, minSearchers })` in
  `lib/agent-search-demand.ts` applies the SAME operator/code veto the published term tiers
  apply, reused from the module that owns these predicates rather than restated.
- Worked example: four agent-source catalog searches by distinct searchers (`cat-a` 2 results,
  `cat-b` 1 result, `cat-c` 0 results, `cat-d` 3 results) at `{ days: 30, minSearchers: 3 }` give
  `{ total: 4, matched: 3, missed: 1 }`. Insert the normalized form of `cat-d`'s term into
  `hidden_search_terms` and the same call gives `{ total: 3, matched: 2, missed: 1 }`.

**The shape gate, in both forms**

- `lib/search/gates.ts` gains an exported SQL twin, `publishableQuestionShape()`, that takes no
  arguments and returns a drizzle SQL fragment usable directly as a boolean select expression,
  e.g. `select ${lookups.generalizedQuery} as query, ${publishableQuestionShape()} as sql_shape
  from ${lookups}`. It reads the same normalized-question expression the existing question veto
  reads, so both forms key off the same text.
- It must reuse the existing canonical-test-question pattern's own `source` rather than a
  hand-copied string.
- The twin and the existing TypeScript predicate `isPublishableQuestionShape` must agree on every
  case in the TypeScript predicate's own unit suite. The parity test inserts these sixteen
  strings as `lookups.generalized_query` and asserts the SQL result equals
  `isPublishableQuestionShape(query)` row by row: `'x'`, `'  Hi  '`, `'12345'`, `'???'`,
  `'test'`, `'Testing'`, `'test 2'`, `'testing_03'`, `'test-7'`, `'why x402?'`,
  `'is x402 live?'`, `'how do i test an x402 server?'`, `'testnet rpc'`, `'  TEST   '`,
  `'😀a'`, `'😀😀a'`.
- `isPublishableQuestionShape('😀a')` is `false` and `isPublishableQuestionShape('😀😀a')` is
  `true`. The length check counts CODE POINTS, not UTF-16 code units: `'😀a'` is three code units
  but two code points, and Postgres `length()` counts code points, so a code-unit check would
  disagree with the twin at exactly this boundary. Settle every such disagreement in favour of
  what the database does.
- The other two rules do not move: a question with no letter at all is refused, and a canonical
  test question (`test`, `Testing`, `test 2`, `testing_03`, `test-7`, `  TEST   `) is refused.
  `'testnet rpc'` and `'how do i test an x402 server?'` are kept.

**The answer half's shape gate**

- The answer half applies the SQL twin beside the veto it already runs.
- Worked example: five `lookups` rows at `{ days: 30, minSearchers: 3 }` — three real
  (`'why does x402 need a facilitator'` matched, `'is x402 live'` missed, `'does drizzle push run
  migrations in order'` matched), plus `'testing_03'` and `'12345'` — give
  `{ total: 3, matched: 2, missed: 1 }`. `'testing_03'` is deliberately NOT in the code veto
  list, so only the new shape gate can drop it.

**Unchanged**

- Both halves keep their windows, their existing probe, dogfood and published-example
  exclusions, and every existing counting rule. The summary keeps its
  `{ total, matched, missed }` shape and its `null`-on-zero behaviour. Existing cases in the
  focused test file must keep their current numbers.
- Keep both new predicates in the module that already owns these predicates. A gate with a second
  home is how it goes missing on one surface.

## Constraints

Work within `lib/`. Preserve every existing interface and all unrelated behaviour. Do not change
dependencies. Run only the focused test files for this change: `lib/search/gates.test.ts` and
`tests/integration/search-telemetry.test.ts`. The second boots a Postgres container and needs
Docker; its locale is `C.UTF-8`, which is what the letter-class and length semantics were
verified against. Do not run the full suite.
