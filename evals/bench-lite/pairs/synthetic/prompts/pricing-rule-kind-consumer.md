You are working in the Ledgerline service repository. Implement the ticket below.

Run only the test files you need. Never run the whole suite with no file argument, and never
leave a process running. Do not spawn subagents.

---

## LED-596 — a volume discount on large scale debits

Sales have promised two scale accounts a discount on large debits, and the contracts are signed.
Above 1,000.00 the proportional fee drops by 15 per cent. It applies to scale debits only.

Prices are written as rules, so this is a new kind of rule rather than a special case in the
pricing code.

### Interface contract

`src/pricing/rules.ts`

- `PricingRule` gains a third variant:

  ```ts
  {
    plan: Plan;
    appliesTo: EntryKind;
    kind: 'tier';
    aboveCents: number;
    discountBasisPoints: number;
  }
  ```

- `PRICING_RULES` gains exactly one of them, and no other rule changes:
  `{ plan: 'scale', appliesTo: 'debit', kind: 'tier', aboveCents: 100_000, discountBasisPoints: 1_500 }`

`src/pricing/table.generated.ts`

- Every cell in `PRICING_TABLE` gains `tier`, either
  `{ aboveCents: number; discountBasisPoints: number }` or `null` where no tier rule applies.
- The table still holds exactly the six keys it holds today.

`src/pricing/index.ts`

- `PriceCell` gains `tier: { aboveCents: number; discountBasisPoints: number } | null`.
- `priceFor(plan, kind, amountCents)`: take the flat part plus the proportional part, as today
  and unrounded. If the cell has a tier and `amountCents` is **strictly greater** than
  `aboveCents`, multiply by `(10_000 - discountBasisPoints) / 10_000`. Then round to a whole
  cent, half up, and never below zero.
  - `priceFor('scale', 'debit', 100_000)` is `150`.
  - `priceFor('scale', 'debit', 100_001)` is `128`.
  - `priceFor('scale', 'debit', 150_000)` is `191`.
  - `priceFor('scale', 'debit', 200_000)` is `255`.
  - `priceFor('scale', 'credit', 1_000_000)` is still `500`.
  - `priceFor('standard', 'debit', 1_000_000)` is still `2_510`.
- An entry posted through `postEntry` carries the discounted fee in `feeCents`.

### Compatibility

The repository's own tests under `tests/` are yours to update where this ticket changes what
they assert, and only there; a cell gaining a field is such a change. Everything the ticket does
not name keeps behaving as it does today. Run the test files you touch.

### Out of scope

More than one tier per cell, and any tier on a plan other than scale.
