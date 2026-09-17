Rank all search surfaces using what a piece says. Remove creator answer-card text and card vectors as ranking evidence. A card stuffed with query vocabulary must not displace genuinely relevant content. Preserve each surface’s existing visibility, creator, price, facet and card-eligibility rules; display/browse may retain eligible cardless pieces. Keep the retired card indexes and generation available but unqueried for rollback.

Use a 0.47 content-cosine floor for decision/display while preserving unfloored browse behavior. Search a pool of 800 dense chunks and cap content generation at the first 256 chunks per post, preventing one long post from consuming the candidate pool.

Never expose body text, snippets, chunk data, vectors, raw scores or distances through search responses. Preserve useful public candidate/card metadata and accurately describe the ranking source in machine-facing contracts.

Partition the configured daily embedding allowance into decision 35%, generation 35%, answer 20%, display 10%, with a minimum allowance of one per surface. Charge actual calls to the correct surface. Cache hits and a MISS browse continuation reuse the query vector; exhausted budgets degrade without calling the provider.

Apply a 1,000-per-day caller limit alongside existing burst limits to v2 decision, v3 decision/display and query-bearing articles requests. Suggest and non-search listing remain outside that daily limit. Daily counters must survive intermediate cleanup and expire according to their actual window.

Persist nullable dense_contributed telemetry, bounded between zero and candidate count. Count only dense candidates surviving the response budget, including search and answer paths; MISS contributes zero. Include the schema migration and compatible historical rows.

Work within the supplied product source: src/ for agent tasks; lib/, app/, and drizzle/ for server tasks. Preserve existing interfaces and unrelated behavior. Do not change tests, dependencies, or benchmark support. Run relevant focused tests only. Services, installs, payments, and publication must use the supplied inert test facilities; do not contact production.
The supplied disposable database supports existing focused Node/integration tests with: pnpm exec vitest run --config .bench1/model-tests.config.mjs --configLoader runner tests/integration/<relevant-file>.test.ts. Use the corresponding lib test path for a focused unit test. The original root Testcontainers setup cannot access Docker here; do not use it. Hidden final verification is separate.
