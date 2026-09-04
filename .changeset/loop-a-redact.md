---
'tenjin-cli': minor
---

One redact module, one rule table. `src/lib/redact.ts` replaces `scan.ts`: `findings(text,
scope)` is the publish scan with the audience as a parameter (`publish` reports every rule,
`team` reports only the rows scoped to it, so `publish`, `edit` and `sync` pass a scope and
filter nothing), and `mask(text)` is the new query-side verb the hook templates render inline
from the same table. `redact-rules.json` carries `scopes: ('query' | 'publish' | 'team')[]` per
rule instead of a `teamSurvives` flag; `secret-assignment` gains a second entry for the
space-separated `--api-key <v>` flag form, and reads a JSON-quoted name (`"password": "…"`)
the way gitleaks does, so a flag-passed or JSON-dumped key is caught on a team shelf
(tenjin-agent#281).
One fixture set, `redact.fixtures.json`, replaces `scan-corpus.json`.

**`mask()` is precise, and it masks rather than deletes.** For a query, only the rows scoped
`query` — vendor-prefixed tokens (`ghp_…`, `sk-ant-…`, `AKIA…`), a password inside a connection
URI, an `Authorization: Bearer` header, and a `NAME=value` secret assignment — are replaced,
each by a masked stub (`ghp_…[redacted 36 chars]`) that keeps the type-identifying prefix, never
the matched value. Nothing else is touched: a path, a hostname, an IPv4 literal, a commit SHA,
an env-var name, an email address and ordinary prose all ship whole, because those are the
identifiers the shelf's search ranks on. Measured on 3,760 real prompts before this decision:
the old scrub altered 604 of them and deleted 1,032 paths, URLs and ids to stop 2 vendor tokens
total. The hook templates (`push-scripts.ts`, `hook-scripts.ts`) now render `mask()` inline from
the table's `query` rows at generation time, replacing the standalone `SECRET_*_RE` list and
`scrub(text, mode)` entirely; every caller that used to pass `'secretsOnly'` now calls `mask()`.

**Publishing: the local scan is warn-only, and the marketplace is the only blocker.** `publish`
and `edit` route every local finding through the standing `publish.mode` consent flow — `review`
asks, `auto` returns `NEEDS_CONFIRMATION`, `full-auto` clears it — including a block-tier shape;
the local hard-block branch and its "never clearable" wording are gone. The marketplace's own
ingest scan is the one place a write can still be refused outright (`PUBLISH_BLOCKED`, vendor
tokens, private keys, seed phrases, DB passwords, bearer headers), unchanged, and no `--yes` or
mode clears that. `sync` stops scanning locally: it sends every Fix note now, and the server's
existing refusal is counted under `skipped`, as before, and covers what a local scan used to hold back.

**Which rows a shelf flags is data.** `team` scope (both the local flag list and the shelf's own
"is this safe to make public" triage) is now the block-tier rows plus `secret-assignment` (and
`hex32-value`, `raw-private-key`'s warn form) — down from six survivors to two; `high-entropy-
string`, `env-dump-block` and `embedded-instruction` are public-only. `private-repo-reference`
and `scan-context.ts` are deleted: a public-only nicety about the author's own repo slug, and the
only rule that needed caller context.

Docs, the `tenjin-publish` skill and `docs/safety-model.md`/`docs/command-reference.md` are
updated to match: no more local "hard block", the team-shelf survivor list, and the hook
template's masked-not-deleted behavior.
