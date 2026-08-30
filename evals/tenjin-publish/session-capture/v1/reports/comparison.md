# Session-capture synthetic smoke v1 comparison

Status: **not run**.

The frozen 30-case **synthetic smoke** fixture, labels, questions, evaluator,
and predeclared ceilings are present. It is not the recorded held-out archive
benchmark. No baseline or treatment replay has been executed from a pinned
clean checkout, no controlled publication has run, and no retrieval or
consumer-use result exists. Accordingly, this file reports no score, delta, or
product claim.

Relative timing is not replayed: long/resumed offsets, elapsed-time windows,
and generation re-arm behavior are unmeasured. Consumer use is also explicitly
blocked, not run, because the ordinary team-mode UserPromptSubmit hook always
starts a public request and this benchmark permits zero public traffic.

After both local replay JSON files are complete, use `aggregate.mjs` to produce
the thin machine-readable comparison. Add a concise human summary here only
from that aggregate and the ordinary controlled-run receipts. Do not include
question text, prompts, bodies, grader evidence, transcript excerpts, requester
identities, wallets, credentials, raw session UUIDs, or local paths.
