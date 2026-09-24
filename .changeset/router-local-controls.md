---
'tenjin-cli': patch
---

The router has an off switch and a context setting that both hooks and the
`request` tool honour. `tenjin config set router.enabled false` stops it on this
machine, and `tenjin config set --project router.enabled false` stops it in one
repository through a committed `.tenjin/config.json`; `--project --local` writes
a personal `.tenjin/config.local.json` beside it instead, which belongs in
`.gitignore`. Off means the hooks send nothing and the `request` tool answers
`needs_input` naming the key, paying nothing. `router.context turn` sends the
current turn with no prior messages. The nearest project directory wins, and a
project file can only tighten what the global config set. `tenjin config` shows
both keys with the file they came from, and `tenjin doctor` warns when the hooks
are wired but the router is off in the directory it runs from.
