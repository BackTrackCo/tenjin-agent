---
'tenjin-cli': minor
---

Edit a published piece from the CLI. `tenjin edit <postId>` with no flags prints
the stored post and its answer card (title, status, price, url, excerpt, every
card field, and the card's legacy completeness status); with change flags it
merge-updates the post through `PUT /api/posts/<id>`, where an omitted field is
kept, `--clear <field>` sends the explicit clear, and an array flag replaces the
stored list. `--add-question` / `--add-task` are the append convenience: they read
the stored array first, add, dedupe, and send the merged list.

Post fields move with `--title`, `--price`, `--excerpt`, and `--body <file>` (the
file's frontmatter is ignored; metadata changes only through flags). Card fields
take the same flags publish does. Before anything is written you get a terse
before/after summary, and the update is gated by the same deterministic scan and
`publish.mode` consent as publishing: a live secret in the new content hard-blocks
in every mode, and a `review`-mode edit returns NEEDS_CONFIRMATION until you pass
`--yes` (or `--mode` for one run). The MCP server exposes the same core as
`tenjin_edit`.

An edit sends only what actually changes, so re-running the same command writes
nothing: values that already match are dropped, timestamps compare as instants
rather than spellings, and an edit with nothing left to do skips the write
entirely. Clearing a card field on a post that has no answer card is likewise a
no-op instead of a write that would create an empty card. Sessions are now minted
at the scope the run needs, so reading one of your own posts no longer leaves a
write-capable delegation cached on disk.
