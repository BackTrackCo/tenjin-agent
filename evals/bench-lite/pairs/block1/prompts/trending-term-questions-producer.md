# Make trending tell the truth about demand

The trending page prints one undifferentiated stream of agent questions and a headline pulse, and
neither distinguishes a question someone merely asked from one a reader actually paid to have
answered. Readers cannot tell observed demand from candidate matches from real purchases, and the
page's copy claims earnings it cannot evidence. Separate the populations, exclude our own
published sample question and our own probes from every question surface, and add a leading tier
for questions that converted into a settled purchase.

## Contract

The observable interface the tests assert. Implementation is yours.

**The documented sample constant**

- Create `lib/payments/answer-example.ts`, at exactly that path, exporting `ANSWER_BODY_EXAMPLE`
  deep-equal to
  `{ question: 'Which Base DEX aggregators settle x402 payments today?', freshWithin: 'P30D' }`.
- Every question surface and the pulse exclude that question from the SAME constant. The test
  imports the module directly and also asserts the file exists.

**The question shape gate**

- `lib/search-telemetry.ts` exports `isPublishableQuestionShape(query: string): boolean`.
- `true` for `'why'`, `'x402?'`, `'测试三'`, `'a'.repeat(100)`, `'testimony'`,
  `'testing process'`.
- `false` for `''`, `' hi '`, `'12345'`, `'!!!'`, `'test'`, `'TEST2'`, `'testing_03'`.
- The only shape exclusions, applied after normalization: two or fewer characters, no letters at
  all, or a match of `^(test|testing)([\s_-]*\d+)?$`. Do not introduce word-count minima,
  vocabulary rules, client deny-lists or session-wide taint.

**The question tiers**

- `lib/search-telemetry.ts` exports `getConvertedQuestions(db, { days, limit, maxPerRequester })`
  returning the existing `AgentQuestionRow[]` shape. Each returned row's own key set is exactly
  `['answered', 'askedOn', 'query', 'requesters']`, and its date is day-precision only:
  `askedOn` matches `/^\d{4}-\d{2}-\d{2}$/`. No identity and no precise timestamp.
- Every question reader — the four public tiers `getAgentQuestions`, `getAnsweredQuestions`,
  `getWaitingQuestions`, `getConvertedQuestions`, and the moderation queue
  `getPendingAgentQuestions` — drops all of: the sample question in any case or interior-whitespace
  variant after normalization; the historical exact code vetoes, including `'a question'`;
  anything under the reserved probe prefix `zzq_probe_`; anything the shape gate refuses
  (`'test2'`, `'testing_03'`, `'hi'`, `'12345'`); any question whose normalized text is present in
  `hidden_search_terms`; and any row whose `client_name` is a probe client (`'tenjin-eval'`,
  `'TENJIN-ADMIN-PROBE'`). Real questions beside them must survive, so the exclusions cannot be
  implemented as a blanket filter.
- The moderation queue keeps what the public tiers drop for freshness or single-source reasons:
  with one MISS asked 1 hour ago, one 40 hours ago, and one 30 hours ago,
  `getAgentQuestions` returns only the last, while `getPendingAgentQuestions` returns all three.

**Conversion**

- A settled payment made by someone OTHER than the piece's owner establishes conversion, even
  with a single requester: the distinct-requester floor does not apply to this tier.
- A payment whose payer address is the post owner's wallet does not convert. A settled payment
  with no lookup link does not convert.
- Conversion is keyed on the NORMALIZED question group: a payment linked to any lookup in the
  group converts the group, and a later unpaid MISS lookup with the same normalized text must not
  erase it. In that case the converted row reports `{ answered: false, requesters: 2 }` and the
  same question still appears in `getWaitingQuestions`.
- Windows: conversion uses the lookup window and the ordinary persistence delay, while the page
  reads a longer window. With three sales on lookups 1 hour, 480 hours and 768 hours old,
  `getConvertedQuestions(db, { days: 30, ... })` returns only the 480-hour one, and the same call
  at `days: 7` returns `[]`.
- Preserve the other publication gates on this tier: the 24-hour delay, the vetoes, probe and
  display filtering, and the per-requester cap. With four sales from one requester,
  `maxPerRequester: 2` returns exactly two rows. A question carrying an email address and one
  300 characters long are both excluded by the existing display rules.

**The pulse**

- `getAgentSearchDemandSummary(db, { days, minSearchers })` in `lib/agent-search-demand.ts`
  excludes ONLY the documented sample question. It keeps rows with NULL question text and keeps
  catalog-side rows carrying the sample words. The worked example: three sample-question lookups,
  one matched question, one missed question, one NULL-text lookup and three catalog searches on
  the sample text give `{ total: 6, matched: 5, missed: 1 }`, while
  `getTopSearchTerms(db, { days: 30, limit: 25, minCount: 3, source: 'agent' })` still returns the
  sample as a term. Catalog term behaviour is unchanged.

**The page**

- `readTrendingPageDemand(db)` in `lib/trending-demand.ts` keeps its existing fields and its
  rendered caller interfaces, and gains `converted`. For the fixture in the test it returns
  `summary` equal to `{ total: 8, matched: 5, missed: 3 }`, with `converted`, `waiting` and
  `answered` each holding the rows of their own population and no row appearing in two of them.
- `DemandBody` in `app/trending/_components/demand-body` renders exactly three `<section>`
  elements that contain an `<h2>`, in the order converted, waiting, answered. The first `<h2>`'s
  text content is exactly `Answered and bought`. Each section's text contains every query of its
  own population and none from the other two.
- The third section describes candidate matches without claiming earnings: its text matches
  `/candidate|match/i` and must NOT contain the string `Each answer now earns on every read`.
- The page prints a truthful pulse in a `<p>`: with the fixture above, one paragraph matches
  `/\b8(?:\s+\w+){0,2}\s+search/i`, and that same paragraph matches
  `/\b5(?:\s+\w+){0,2}\s+(?:answer|match|candidate)/i`,
  `/\b3(?:\s+\w+){0,2}\s+(?:wait|miss|unanswered)/i` and `/30\s+days/`.

**The landing section**

- `readLandingQuestions(db)` returns `[]` on an empty database, and otherwise a narrower
  seven-day subset under the same filters: with one ordinary question and one sample question
  asked, it returns only the ordinary one.
- `AgentsAsking` in `app/_components/agents-asking`, given `questions: []`, renders zero `<li>`,
  at least one `<p>` matching `/quiet|no question|nothing|not enough|empty/i`, a `<button>` or
  `<a>` whose text matches `/set up.*agent/i`, and an `a[href="/trending"]`.
- Given the populated rows it renders one `<li>` containing the question text and the literal
  string `asked by 2`.
- The quiet-state action must reach REAL setup instructions, not a placeholder. If it renders as
  an anchor, its `href` is exactly `/agents`, and `app/agents/page` renders the exported
  `AGENT_SETUP_PROMPT` from `app/_components/agent-prompt` together with a `<button>` matching
  `/copy prompt/i`. If it renders as a button, clicking it opens a `[role="dialog"]` that either
  contains `AGENT_SETUP_PROMPT` plus a `/copy prompt/i` button, or contains the MCP URL
  (`NEXT_PUBLIC_APP_URL` with any trailing slash removed, plus `/api/mcp`), an
  `a[href="https://claude.ai/settings/connectors"]` and an `<ol>` matching `/custom connector/i`;
  a chooser step whose button matches `/in a terminal/i` may stand between the two.
- Components render inside `AgentDrawerProvider` from `app/_components/agent-drawer`.

**Historical compatibility**

- Preserve the historical exact code-veto strings and the reserved `zzq_probe_` prefix through
  shared exclusion semantics rather than a new list.
- Preserve the existing display and requester caps rather than inventing new thresholds.
- Order the page bought, waiting, matched.

## Constraints

Work within the supplied product source: `lib/`, `app/` and `drizzle/`. Preserve existing
interfaces and unrelated behaviour. Do not change tests, dependencies, or benchmark support. Run
relevant focused tests only. Services, installs, payments, and publication must use the supplied
inert test facilities; do not contact production. The supplied disposable database supports
existing focused Node/integration tests with
`pnpm exec vitest run --config .bench1/model-tests.config.mjs --configLoader runner tests/integration/<relevant-file>.test.ts`;
use the corresponding lib test path for a focused unit test. The original root Testcontainers
setup cannot access Docker here; do not use it. Hidden final verification is separate.
