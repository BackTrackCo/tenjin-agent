---
'tenjin-cli': patch
---

Move the auto-mode permission reference out of the README and into
`docs/agent-permissions.md`. Nothing was deleted: the per-verb rationale, the
`--base-url` prefix-rule caveat, what a cached session key is really worth, the
walk-through of the spend-policy defaults an allowlisted `buy` runs under, the
`session start` opt-in, the never-recommended verbs and their reasons, the two
fail-closed gaps, and the MCP tool-surface note all moved verbatim and are now
organized under headers a reader can scan. The new page ships with the package.

What stays in the README is what a reader needs in the moment: the nine-line
paste block, a three-tier summary (free verbs cannot spend and cannot open the
keystore; `buy` is a separate opt-in that can spend; `session start` is a separate
opt-in that opens the keystore), a note that `tenjin install` can wire the free
tier for you (`--allow-free-verbs` headless), and a link to the full page. The
consent-modes section gets the same treatment: one line per mode, with the
`.tenjin.json` downgrade rule and the `--yes` sentence kept.

The README's install section now describes the three-question walkthrough and
quotes the copy the CLI actually prints, and names the flag that settles each
question headlessly.
