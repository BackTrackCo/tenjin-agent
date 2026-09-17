# Leak check — tenjin-746-748-confidence (v2 prompts)

## The shared fact, quoted from the producer's merge commit (ee76fc4)

`lib/search/project.ts:145`

```ts
confidence?: 'high' | 'medium' | 'low';
corroborated?: boolean;
```

`lib/search/project.ts:266-267, 285-297`

```ts
const CONFIDENCE_HIGH_SIMILARITY = 0.62;
const CONFIDENCE_MEDIUM_SIMILARITY = 0.52;

function deriveConfidence(row: LookupRow, calibration: SearchCalibration) {
  if (calibration !== 'hybrid-v1' || row.score === undefined) return undefined;
  if (!row.semanticHit) return 'low';
  ...
  if (similarity >= CONFIDENCE_HIGH_SIMILARITY) return 'high';
  if (similarity >= CONFIDENCE_MEDIUM_SIMILARITY) return 'medium';
  return 'low';
}
```

Both constants and both derive functions are module-private at the producer's merge commit. The
bucket reads the DENSE leg's cosine alone; `corroborated` is the separate both-legs fact.

## Why the consumer needs it

`app/api/answer/route.ts` at the consumer's merge commit (83fa8ba):

```ts
qualify: (row, cal) => {
  const confidence = deriveConfidence(row, cal);
  return confidence === 'high' || confidence === 'medium';
},
```

and `tests/integration/answer.test.ts` imports the medium threshold by name at line 48, placing
fixtures at `atCosine(CONFIDENCE_MEDIUM_SIMILARITY + 0.05)` and asserting
`DENSE_COSINE_SIMILARITY_FLOOR + 0.02 < CONFIDENCE_MEDIUM_SIMILARITY`.

## Grep, run against the v2 consumer prompt

```
$ grep -icE "deriveConfidence|confidence|corroborat|'high'|'medium'|'low'|0\.62|0\.52|CONFIDENCE_|cosine|bucket" \
    prompts/tenjin-746-748-confidence-consumer.md
1
$ grep -inE "deriveConfidence|confidence|corroborat|'high'|'medium'|'low'|0\.62|0\.52|CONFIDENCE_|cosine|bucket" \
    prompts/tenjin-746-748-confidence-consumer.md
68:- The oracle also imports `DENSE_COSINE_SIMILARITY_FLOOR` from `@/lib/search`, which is already
$ grep -inE "\bhigh\b|\bmedium\b|\blow\b|dense cosine|similarity >=" \
    prompts/tenjin-746-748-confidence-consumer.md
(no output)
```

The one hit is `DENSE_COSINE_SIMILARITY_FLOOR`, which exists at the CONSUMER's own base commit
(`lib/search/fuse.ts`, imported by `tests/integration/lookup-hybrid.test.ts` at base) and is not
the producer's contribution. Zero hits on the field names, the enum values, the thresholds, the
derive functions and the dense-leg-alone rule.

The v2 consumer prompt says "a strong enough semantic match", "a hit the keyword leg alone found
never qualifies", and "the same per-candidate match-strength signal the shortlist route already
publishes". It names no field, no enum value, no threshold and no function. Wording was changed
from the v1 prompt to remove "confident"/"confidently", which shared a stem with the field name.

## Deliberate partial disclosures in the v2 prompt

- The prompt says the oracle imports ONE module-private constant from `@/lib/search/project` and
  that it must be widened to `export`. It does not name the constant, its value, or what it
  means. The module path is disclosed because the export is the consumer's own diff and an
  agent cannot widen a binding in a module it is not allowed to know about. The oracle's import
  statement discloses the identifier anyway the moment the test is run.
- `qualify`, `runRetrieval`, `LookupRow` and `SearchCalibration` are named. These are the
  consumer's OWN interface (the `qualify` option is added by this PR) or pre-existing at its
  base; none is the producer's contribution.
- `'hybrid-v1'` and `'lexical-v1'` are named. Both predate the producer PR.

## Oracle-level leak, unchanged from v1 and not fixable in the prompt

`tests/integration/answer.test.ts` imports `CONFIDENCE_MEDIUM_SIMILARITY` by name from
`@/lib/search/project`, so running the oracle tells agent B the constant's identifier and module.
It does not reveal the value (0.52), the high cut (0.62), the enum values, or that the bucket
reads the dense leg alone. Flagged, not fixed.
