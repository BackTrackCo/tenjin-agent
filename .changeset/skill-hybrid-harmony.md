---
'tenjin-cli': patch
---

Align the vendored skills with hybrid retrieval. `tenjin-search` now says lookup
matches wording and meaning and to send the whole question as one
natural-language sentence instead of compressing it to keywords, and its
candidate-parking example passes `--question` so the searcher's phrasing becomes
a `questionsAnswered` entry on the published card. `tenjin-publish` spells out
how to phrase that card: 5 to 10 `questionsAnswered` entries of at most 200
characters, varied in register, `tasksSupported` kept to tasks, and a dense
factual `scope` because scope is searched too. The README lookup guidance
matches.
