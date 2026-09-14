# The headline demand number counts questions no list will show

The number we publish for how much agent demand the marketplace saw never consulted the veto the
question lists apply. An operator hides a junk question from every list, the lists obey, and the
headline total keeps counting it, so a reader sees a figure they cannot reconcile against
anything on the page. The reason it stayed invisible is that the two halves of the count read
different tables: the half the veto covers is unioned in from a source the lists never render, so
a vetoed row vanished from every list while still moving the total with nowhere for a reader to
look. Apply the existing veto to the half that has one, through the seam that already exists.

## Contract

The observable behaviour the test asserts. Implementation is yours.

- `getAgentSearchDemandSummary(db, { days, minSearchers })` in `lib/agent-search-demand.ts` keeps
  its signature and its `{ total, matched, missed }` result shape, and keeps returning `null`
  when the total is zero.
- The answer half of the union (the `lookups` half) applies the operator-and-code question veto
  the question lists already use. Reuse the exported predicate that owns it; do not write a
  second copy of the rule next to the count, and do not add a new list, a new column or a new
  operator knob.
- The veto is data-driven and takes effect with no deploy: a row inserted into
  `hidden_search_terms` whose `term` is the NORMALIZED question drops that question from the
  count, even when it is inserted after the lookups were logged.
- Rows whose stored question text is NULL stay counted. Such a row is missing telemetry, not a
  synthetic event. This is the trap: the veto compares a normalized question, which is NULL for a
  request that stored no text, so without an explicit guard for the absent case every existing
  case silently halves.
- Worked example the test pins, all rows inside the window, `{ days: 30, minSearchers: 3 }`:
  four real requesters (`real-a` texted and matched, `real-b` texted and missed, `real-c`
  UNTEXTED and matched, `real-d` texted and matched) plus two synthetic rows carrying the
  code-vetoed strings `'a question'` and `'What is the latest on Found 3 article(s).?'` give
  `{ total: 4, matched: 3, missed: 1 }`. After inserting the normalized form of `real-a`'s
  question into `hidden_search_terms`, the same call gives `{ total: 3, matched: 2, missed: 1 }`.
- Do not change the catalog half of the union, the window, the distinct-requester floor, or the
  probe, dogfood and published-example exclusions already applied.
- State in a comment that this is NOT full parity with the lists: the lists also require a
  publishable shape and a displayable length, and their window is shorter, so a counted row can
  still be unlistable.

## Constraints

Work within `lib/`. Preserve every existing interface and all unrelated behaviour. Do not change
dependencies. Prove the new predicate is not vacuous by removing it and watching the count
change. Run only the focused test file for this change:
`tests/integration/search-telemetry.test.ts`. It boots a Postgres container and needs Docker. Do
not run the full suite.
