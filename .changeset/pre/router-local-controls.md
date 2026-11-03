---
'tenjin-cli': patch
---

The router has an off switch and a context setting that every router hook and the
`request` tool honour. `tenjin config set router.enabled false` stops it on this
machine, and `tenjin config set --project router.enabled false` stops it in one
repository through a committed `.tenjin/config.json`; `--project --local` writes
a personal `.tenjin/config.local.json` beside it instead, which belongs in
`.gitignore`. Off means the hooks send nothing and the `request` tool answers
`needs_input` naming the key, paying nothing. `router.context turn` sends the
current turn with no prior messages. Every project file from the working
directory up to the git root applies (in a git worktree, the main checkout's
too), and each can only turn the router off or narrow what it sends. `tenjin config` shows
both keys with the file they came from, and `tenjin doctor` warns when the hooks
are wired but the router is off in the directory it runs from.
