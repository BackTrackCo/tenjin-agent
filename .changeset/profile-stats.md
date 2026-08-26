---
'tenjin-cli': minor
---

Two account verbs, so a CLI-only publisher is not listed under a bare 0x address
(tenjin-agent#208). `tenjin profile` shows the handle, display name, and bio behind
the wallet; `tenjin profile set --handle <h> [--display-name <n>] [--bio <t>]`
claims or renames the handle and sets the rest (omitted flags keep their stored
value). `tenjin stats` prints this month's earnings, full reads, and glances. All
three ride the same session-key auth `publish` and `edit` use, so a team shelf
needs nothing extra and a cached session means no wallet prompt. No consent gate
and no permission-tier entry: these are operator-invoked account edits, not content.
