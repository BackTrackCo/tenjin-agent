---
'tenjin-cli': patch
---

A router packet no longer carries rows the harness writes into the user's turn. A
background task or subagent finishing (`origin.kind: "task-notification"`) and a local
command's output (`<local-command-stdout>`, `<local-command-stderr>`) arrive as
`type: "user"` rows without `isMeta`, so they were read as the user's words: they travelled
in `history`, and one could become `current`, even with `router.context turn`. They are now
skipped like harness meta rows. A `<command-name>` row, the command the user typed, stays.
