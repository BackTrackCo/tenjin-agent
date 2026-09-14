Make trending distinguish observed questions, candidate matches and actual purchases. Exclude the published answer-payment example from every question tier, pending moderation and the associated pulse count, using the same documented example everywhere. Apply existing exact operator/code vetoes and the reserved probe-prefix exclusion consistently.

Add only these question-shape exclusions after normalization: two or fewer characters, no letters, or ^(test|testing)([\s_-]*\d+)?$. Do not introduce word-count minima, vocabulary rules, client deny-lists or session-wide taint.

Add a leading “Answered and bought” question tier covering 30 days. A settled payment by someone other than the piece’s owner establishes conversion, even without multiple requesters. Preserve the other publication gates: 24-hour delay, veto, probe/display filtering and requester caps. A qualifying payment linked to any lookup in a normalized question group can establish conversion; an unpaid later lookup must not erase it.

Order the page bought, waiting, matched. Describe candidate matches without claiming earnings. Keep catalog term behavior unchanged. The landing section remains a narrower seven-day question subset; its quiet state offers a working agent-setup action.

The following final historical compatibility requirements are reconstructed from source:
- Preserve historical exact code-veto strings and reserved zzq_probe_ prefix through shared exclusion semantics.
- Preserve existing display and requester caps rather than inventing new thresholds.

Required benchmark compatibility interfaces: expose getConvertedQuestions(db,{days,limit,maxPerRequester}) returning the existing AgentQuestionRow[] shape, and isPublishableQuestionShape(query): boolean, from lib/search-telemetry.ts. Expose ANSWER_BODY_EXAMPLE from lib/payments/answer-example.ts with the documented question and freshWithin:P30D. Extend existing readTrendingPageDemand(db) with converted rows and preserve its other fields and rendered caller interfaces.

Work within the supplied product source: src/ for agent tasks; lib/, app/, and drizzle/ for server tasks. Preserve existing interfaces and unrelated behavior. Do not change tests, dependencies, or benchmark support. Run relevant focused tests only. Services, installs, payments, and publication must use the supplied inert test facilities; do not contact production.
The supplied disposable database supports existing focused Node/integration tests with: pnpm exec vitest run --config .bench1/model-tests.config.mjs --configLoader runner tests/integration/<relevant-file>.test.ts. Use the corresponding lib test path for a focused unit test. The original root Testcontainers setup cannot access Docker here; do not use it. Hidden final verification is separate.
