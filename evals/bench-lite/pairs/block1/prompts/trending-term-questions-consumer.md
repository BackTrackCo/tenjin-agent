# A bare catalog term should not be published twice

The trending page publishes agent search terms and agent questions side by side, and a question
whose whole text is a bare catalog term appears in both. The reader sees the same string promoted
twice, once as a term with its search count and once as a question, which reads as two independent
signals when it is one. Suppress a question whose normalized text equals a term already qualifying
for publication, while keeping it visible to moderation, since term eligibility can disappear
later and the question then has to come back.

## Contract

The observable interface the tests assert. Implementation is yours.

**The suppression rule**

- A question is suppressed from EVERY public question tier reader that
  `lib/search-telemetry.ts` exports when its normalized text equals a term that currently
  qualifies for either published term tier (met or unmet).
- It is NOT suppressed from `getPendingAgentQuestions`, the moderation queue, which keeps
  returning it.
- Comparison uses the existing normalization contract only: case, interior ASCII whitespace runs,
  and surrounding spaces. Broader Unicode equivalence is not required. So a question stored as
  `'  QUARTZ   LENS '` is suppressed by a term `'quartz lens'`.
- Worked truth table, run against each public tier in turn. Terms: `'quartz lens'` with 3
  distinct searchers and results, `'amber prism'` with 5 distinct searchers and no results,
  `'ceramic mirror'` with 2 distinct searchers and results. Questions asked:
  `'  QUARTZ   LENS '`, `'amber prism'`, `'ceramic mirror'`, `'why does the quartz lens fog'`,
  `'how are silver mirrors cleaned'`. Every public tier returns exactly
  `['ceramic mirror', 'how are silver mirrors cleaned', 'why does the quartz lens fog']` and
  `getPendingAgentQuestions` returns all five.
- Both met and unmet terms suppress: `'quartz lens'` qualifies on the met side and `'amber prism'`
  on the unmet side, and both of their questions disappear. `'ceramic mirror'` is below its floor,
  so its question stays.

**Bounds on the rule**

- Agent-source terms only. A term recorded with `source = 'web'` does not suppress anything:
  `'silver lens mount'` as a web term keeps its question.
- At most three words. `'copper lens mount'` suppresses its question; `'copper lens mount
  alignment'` does not.
- At most eighty code points. `'f'.repeat(80)` suppresses its question; `'g'.repeat(81)` does not.
  Promoting a whole sentence as a term must not be able to hide the corresponding question.
- Term eligibility, not term DISPLAY: a term that qualifies but ranks beyond the display limit
  still suppresses. With 28 other qualifying terms ahead of it,
  `getTopSearchTerms(db, { days: 30, limit: 25, minCount: 3, source: 'agent' })` returns 25 rows
  not containing `'zinc target'`, and `getAgentQuestions` still returns nothing for the
  `'zinc target'` question.

**Suppression is not permanent, and does not waive moderation**

- When the term stops qualifying, the question returns under its ordinary rules. Age every
  `search_queries` row for `'violet optics'` out past the term window and the question appears in
  `getWaitingQuestions` again.
- A question that is still inside its own moderation delay does NOT become public just because its
  term expired: a question asked 1 hour ago whose term has aged out stays out of
  `getAgentQuestions` and stays in `getPendingAgentQuestions`.

**Everything else is preserved**

- Both term tiers keep their existing rows, floors, windows, ordering and agent-source
  restriction. `readTrendingDemand(db)` on the mixed fixture returns `top` equal to
  `[['healthy lens', 6], ['rescued demand', 10]]` and `unmet` equal to
  `[['formerly found', 11], ['wanted prism', 10]]`, by `[query, searches]`. A below-floor term, a
  web-source term, an expired term, a too-young unmet term, a rescued term and a term whose latest
  result count fell to zero all keep their current treatment.
- Ordinary question moderation survives the change: the operator veto (`hidden_search_terms`),
  every existing probe-question and probe-client exclusion, and the per-requester cap all still
  apply after the anti-join. With `maxPerRequester: 1` and two questions sharing one latest
  requester, exactly one of the two comes back; a vetoed question, a probe-prefixed question and
  a question from a probe client come back never; an ordinary question comes back.
- Longer questions, expanded questions and questions whose matching term sits below its floor
  remain eligible under their existing rules.

**Where the comparison lives**

- Keep the comparison inside the existing question query. Do not add a new table, a migration, or
  a separate per-caller term lookup.

## Constraints

Work within the supplied product source: `lib/`, `app/` and `drizzle/`. Preserve existing
interfaces and unrelated behaviour. Do not change tests, dependencies, or benchmark support. Run
relevant focused tests only. Services, installs, payments, and publication must use the supplied
inert test facilities; do not contact production. The supplied disposable database supports
existing focused Node/integration tests with
`pnpm exec vitest run --config .bench1/model-tests.config.mjs --configLoader runner tests/integration/<relevant-file>.test.ts`;
use the corresponding lib test path for a focused unit test. The original root Testcontainers
setup cannot access Docker here; do not use it. Hidden final verification is separate.
