---
'tenjin-cli': minor
---

Self-update from the CLI. `tenjin update` fetches the newest version on this
build's own release channel (an alpha build follows `@alpha`, a release follows
`latest`) and installs it by spawning `npm install -g` pinned to the exact
version the registry named; `--check` only reports. A source checkout is refused
with the git instructions, and a pnpm/bun/yarn-managed global is refused with
that manager's install command instead of leaving two installs racing on PATH
order. The daily update nudge now says `run tenjin update` instead of naming an
npm invocation that is only correct for npm-managed installs.
