---
'tenjin-cli': minor
---

Self-update from the CLI. `tenjin update` installs the newest version npm offers
this build and `--check` only reports. The target is the newest of the build's
own channel tag and `latest`, because which tag a publish lands on is a property
of the release pipeline rather than of the version number: `alpha` sat on
0.1.0-alpha.7 while 0.1.0-alpha.8 through .11 shipped on `latest`, and a
channel-only lookup would tell every alpha user they were current. The daily
update nudge resolves the same way, so the two can never disagree.

The install is pinned to the exact version the registry named and runs as
`node npm-cli.js`, never through a shell, which is also the only form win32 can
spawn. It is bounded by a 5 minute budget, runs from the home directory with
`--ignore-scripts`, and npm's own output is sanitized before it reaches a
terminal. Anything that is not a global npm install is refused with the
instruction that is right there instead of writing a global the user never had:
a source checkout updates by git, an npx run has nothing installed to replace, a
project-local copy updates where it is declared, and a pnpm/bun/yarn global
updates through that manager. `--check` answers from all of them.

`tenjin update` is documented as never-allowlisted for agents: it replaces the
binary the agent then runs. The two remaining "upgrade the CLI" hints, in
`doctor`'s stale-skill fix and the newer-wallet-schema error, now name
`tenjin update` rather than an npm invocation that is only correct for
npm-managed installs.
