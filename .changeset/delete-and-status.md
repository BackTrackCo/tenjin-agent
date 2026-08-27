---
'tenjin-cli': minor
---

Take a publish back from the CLI. `tenjin delete <postId>` removes one of your own
pieces through the owner-scoped soft-delete at `DELETE /api/posts/<id>`, and
`tenjin edit <postId> --status draft|published` is the reversible half: `draft`
unpublishes without losing the id or the body, `published` puts a draft up. Both
reuse `edit`'s signing path, and the MCP server exposes them as `tenjin_delete`
(annotated destructive) and a `status` argument on `tenjin_edit`.

**`delete` confirms in every mode, and never reads `publish.mode`.** The mode is
consent to publish, not consent to destroy, so `full-auto` asks here exactly as
`review` does. At a terminal it asks `y/N` inline; anywhere else, including under
an agent or the MCP server, it refuses with `NEEDS_CONFIRMATION` (exit 3) carrying
the title, status, url, the `--yes` command that confirms, and the reversible
`--status draft` alternative, which is the same exit-3 channel `publish` and `edit`
already use. `--status` is an ordinary change flag by contrast: it diffs, it prunes
when it already matches, and it rides the ordinary `publish.mode` gate.

Every successful `tenjin publish` now prints the exact undo commands with the real
post id, and carries them on the `--json` envelope as `data.undo`, so an agent
reporting a publish hands over a real command instead of guessing one. The printed
removal command carries no `--yes`: it starts the undo, so each surface's own
confirmation still runs, and `--yes` appears only in a refusal payload's
`confirmCommand`, which answers a question the user has already been shown.

A server refusal after the confirmation is the new `DELETE_FAILED` (exit 4), whose
message says the piece is still live. No refused delete leaves a write credential
behind: the owner-scoped read that the preview is built from signs with a
`read`-scoped session, and only an actual approval mints `read+write`, so both a
headless refusal and a declined prompt end with nothing on disk that a later write
could reuse. An approved prompt pays one extra in-memory signature for that, with
no second keystore prompt and no extra round trip. `tenjin delete` is never
allowlisted: no mode carries it, and it is not delegable to a subagent.
