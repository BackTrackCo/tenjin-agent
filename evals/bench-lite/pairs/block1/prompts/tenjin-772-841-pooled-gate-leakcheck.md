# Leak check — tenjin-772-841-pooled-gate (v2 prompts)

## The shared fact, quoted from the producer's merge commit (9309532)

Which readers judge a match, and which field does not.

`lib/search/project.ts:270, 296, 308` and `lib/search/index.ts:88` — FOUR readers of
`row.similarity`, three in one module and one in another:

```ts
function deriveConfidence(row, calibration) { ... }        // project.ts
export function deriveCorroborated(row, calibration) { ... } // project.ts
export function semanticallyClose(row) {                     // project.ts
  return row.similarity !== undefined && row.similarity >= DENSE_COSINE_SIMILARITY_FLOOR;
}
function confidentEnough(row, calibration) { ... }           // index.ts — the relevance floor
```

The negative half, `lib/search/types.ts:42-43`: `semanticHit` is window membership and is NOT a
gate; it is what `lookups.dense_contributed` counts. Plus
`lib/search/retrieve/candidates.ts:128` `backfillSimilarity`, `:200` `FUSION_LIMIT = 50`, `:373`
run concurrently with the dense leg, `:288-324` the `qualify` seam before the top-K cut, and
`lib/search/types.ts:38` `awaitingEmbed`.

## Why the consumer needs it

#841 must move EVERY gate onto the pooled number and leave `semanticHit` alone. Finding three of
the four readers leaves the fourth reading the max, and the integration cases
(`tests/integration/lookup-hybrid.test.ts:651-693`) then keep the 20-chunk piece that should have
been refused. It must also compute the pooled score exactly rather than from the beam, which only
matters if you know the beam is a bounded window.

## Grep, run against the v2 consumer prompt

```
$ grep -inE "confidentEnough|semanticallyClose|deriveConfidence|deriveCorroborated|backfill|awaitingEmbed|FUSION_LIMIT|relevance floor|window membership|qualify" \
    prompts/tenjin-772-841-pooled-gate-consumer.md
(no output)
```

Zero hits. No reader is named, the count of readers is not given, the module split is not given,
the backfill and the window bound are not named, and the `qualify` seam is not named.

## Deliberate partial disclosures in the v2 prompt

- `semanticHit` is named four times: once in the "does not move" requirement and three times
  inside the row literals of the truth table. The identifier predates the producer PR (it exists
  at the 746 base), and every one of those rows is a literal in the consumer's own oracle
  (`lib/search/project.test.ts:165-216`). The prompt says it "does not move and stays in
  `matchReasons`"; it does NOT say that it is window membership rather than a gate, which is the
  producer's re-characterization.
- The readers are described by ROLE ("the confidence buckets, the corroboration predicate, and
  the delivery bar"), which is what the consumer's own unit oracle asserts on
  (`confidence`, `corroborated`, `strong`). The fourth reader, the one in the other module, is
  never named or counted; the prompt only states the observable outcome its integration oracle
  asserts, that the long piece is refused and `matched` is `0`. The v1 prompt's phrase "the
  relevance floor drops it" was removed for exactly this reason.
- `DENSE_COSINE_SIMILARITY_FLOOR` and `CONFIDENCE_MEDIUM_SIMILARITY` are named. Both predate the
  producer PR and both are imported by the consumer's own oracle.

## Oracle-level leaks, flagged not fixed

- **Producer side, SEVERE.** `scripts/eval-lookup-recall.test.ts` imports `REGISTERS` from
  `./eval/lookup-gold-set`, and #772 is the PR that ADDS the `junk` register with its eight
  prompts to that file. Copying the gold set hands the agent a third of the task's spec. Drop
  `scripts/eval-lookup-recall.test.ts` and `scripts/eval/lookup-gold-set.ts` from the producer
  oracle together and use `command_narrowed`. The v2 producer prompt therefore states no eval
  contract at all.
- **Consumer side.** The oracle spells `pooledSimilarity` and `chunkCount`, fixing both
  identifiers; the v2 prompt states them, since they are the consumer's own new interface.
