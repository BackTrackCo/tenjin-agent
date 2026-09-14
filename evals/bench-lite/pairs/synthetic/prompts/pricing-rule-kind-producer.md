You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-588 — a minimum fee on the scale plan

Scale is priced proportionally, so a scale account posting a string of small entries pays us
fractions of a cent each time and we carry the cost of the posting. Finance wants a floor: on
scale, a debit never costs less than 20 cents and a credit never less than 10, whatever the
amount. The other plans are not changing.

Prices are written as rules, so this is a new kind of rule rather than a special case in the
pricing code.

### Interface contract

`src/pricing/rules.ts`

- `PricingRule` gains a third variant:

  ```ts
  { plan: Plan; appliesTo: EntryKind; kind: 'floor'; minimumCents: number }
  ```

- `PRICING_RULES` gains exactly two of them, and no other rule changes:
  - `{ plan: 'scale', appliesTo: 'debit', kind: 'floor', minimumCents: 20 }`
  - `{ plan: 'scale', appliesTo: 'credit', kind: 'floor', minimumCents: 10 }`

`src/pricing/table.generated.ts`

- Every cell in `PRICING_TABLE` gains `minimumCents: number`, so a cell is
  `{ flatCents, basisPoints, minimumCents }`. It is `0` on a plan and kind with no floor rule.
  Where more than one floor rule applies to a cell, the largest wins.
- The table still holds exactly the six keys it holds today.

`src/pricing/index.ts`

- `PriceCell` gains `minimumCents: number`.
- `priceFor(plan, kind, amountCents)` computes the flat part plus the proportional part as it
  does today, rounds to a whole cent, and then lifts the result to `minimumCents` if it came out
  below it. Never negative.
  - `priceFor('scale', 'debit', 1_000)` is `20`.
  - `priceFor('scale', 'debit', 100_000)` is `150`.
  - `priceFor('scale', 'credit', 1_000)` is `10`.
  - `priceFor('standard', 'debit', 10_000)` is still `35`.
- `describePricing()` rows gain `minimumCents`, so a row is
  `{ key, flatCents, basisPoints, minimumCents }`.

### Compatibility

The repository's own tests under `tests/` are yours to update where this ticket changes what
they assert, and only there; a cell gaining a field is such a change. Everything the ticket does
not name keeps behaving as it does today. Run the test files you touch.

### Out of scope

Anything about what an entry costs on starter or standard, and any change to how a fee is
stored on an entry.
