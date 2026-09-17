# Leak check — tenjin-789-798-demand-gates (v2 prompts)

## The shared fact, quoted from the producer's merge commit (b8a2371)

`lib/agent-search-demand.ts:55-63`

```sql
-- Guarded on NULL: the veto compares a normalized question, which is
-- NULL when the request stored no text, and such a row is missing
-- telemetry rather than a synthetic event, so it stays counted.
and (${lookups.generalizedQuery} is null or ${notVetoedQuestion()})
```

plus `:64-70` and `:81-87`, where each half of the union computes its own
`>= minSearchers` distinct-requester floor inside its own CTE, so removing one row from a half
can drop that whole half below its floor.

## Why the consumer needs it

`tests/integration/search-telemetry.test.ts` at the consumer's merge commit (205a879) keeps the
producer's own case, which seeds an UNTEXTED `lookups` row and expects it counted. The consumer
composes a second predicate into the same OR, and a composition that loses the NULL guard turns
that case red and halves the existing counts. The consumer's own catalog case seeds a FOURTH
searcher precisely so the veto removes a row without dropping the arm under its floor.

## Grep, run against the v2 consumer prompt

```
$ grep -inE "null|untexted|no text|absent|missing telemetry" \
    prompts/tenjin-789-798-demand-gates-consumer.md
63:  `{ total, matched, missed }` shape and its `null`-on-zero behaviour. Existing cases in the

$ grep -inE "distinct requester|distinct-requester|minSearchers|floor|requester" \
    prompts/tenjin-789-798-demand-gates-consumer.md
17:- The catalog half of `getAgentSearchDemandSummary(db, { days, minSearchers })` in
21:  `cat-b` 1 result, `cat-c` 0 results, `cat-d` 3 results) at `{ days: 30, minSearchers: 3 }` give
53:- Worked example: five `lookups` rows at `{ days: 30, minSearchers: 3 }` — three real
```

Zero hits on the shared fact. The single `null` hit is the function's pre-existing
`null`-on-zero return, which predates the producer PR. The three `minSearchers` hits are the
function's own option name, also pre-existing, appearing inside worked examples; nowhere does the
prompt say that each half applies the floor to ITSELF, or that removing a row can drop a half
below it.

## Removed from the v1 consumer prompt

Two sentences that stated the shared fact and were the reason NOTES.md rated this pair weakest on
the "expensive without the note" axis:

- "Both new predicates go in the same position and with the same handling as the veto that is
  already there; look at how that one is written before you write yours, because the reason for
  its shape is not obvious and the existing cases will quietly change their counts if you miss
  it." — this is the NULL guard, told without naming it.
- "Watch the arithmetic when you write fixtures: each half of the union is gated on how many
  distinct requesters it saw, so a fixture that removes a row can drop its whole half below that
  gate and pass for the wrong reason." — this is the distinct-requester floor verbatim.

Neither is needed for the consumer's own tests, because the fixtures come from the oracle rather
than from the agent. The generic "preserve all unrelated behaviour" constraint is what now stands
between the agent and the halved counts.

## Kept, and why it is not a leak

The code-point length disagreement (`'😀a'` false, `'😀😀a'` true) IS stated, in full. It is not
the producer's fact: it is #798's own discovery, and both values are assertions in the consumer's
own oracle (`lib/search/gates.test.ts:16-21`). Under the SWE-bench rule the consumer prompt is
fully specific about what its own tests assert.

## Oracle-level disclosure

`tests/integration/search-telemetry.test.ts` imports `publishableQuestionShape` and
`isPublishableQuestionShape` from `@/lib/search/gates`, fixing both identifiers and the module.
Stated in the prompt too, since both are the consumer's own interface.
