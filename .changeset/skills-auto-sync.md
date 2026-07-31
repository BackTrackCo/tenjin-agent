---
'tenjin-cli': minor
---

Skills self-heal after a CLI update: the first command run under a new version
refreshes the wired harness skills to the packaged copies and removes any skill
the package stopped shipping, with a one-line notice at a TTY. Runs only on
machines where `tenjin install` was ever run (it stamps the wiring version in
`~/.tenjin/skills-sync.json`), only touches directories that are already wired,
and never affects the triggering command's output or exit code.
