---
'tenjin-cli': minor
---

Self-update from the CLI, and keep itself updated.

`tenjin update` installs the newest version npm offers this build, pinned to the
exact version the registry names; `--check` only reports. The target is the
newest of the build's own channel tag and `latest`, because which tag a publish
lands on is a property of the release pipeline rather than of the version
number: `alpha` sat on 0.1.0-alpha.7 while 0.1.0-alpha.8 through .11 shipped on
`latest`, and a channel-only lookup would tell every alpha user they were
current. The daily check resolves the same way, so the two cannot disagree.

The manager that owns the install performs it: npm, pnpm, and bun are each
driven with their own global-add command, since the PATH race that makes a
second install dangerous comes from cross-manager writes rather than from asking
the owner to do what it already owns. What cannot be driven is refused with the
instruction that is correct there instead of writing a global you never had: a
source checkout updates by git, an npx run has nothing installed to replace, a
project-local copy updates where it is declared, and yarn is refused because
`yarn global add` exists only in yarn 1. `--check` answers from all of them.

New config key `update.mode`, default `auto`. On `auto` the daily check installs
a newer version in the background and reports it once on the next command;
`nudge` keeps the old TTY-only line and installs nothing; `off` stops the check
entirely. Default-on because the nudge is TTY-only and most installs sit on
agent machines where no human ever sees one. It is bounded: never in CI, never
where `tenjin update` would refuse, never until a version has been visible for
24 hours so a bad release can be pulled first, and always detached after the
command's own output so nothing waits on it. A failure says nothing and falls
back to the nudge. Opt out with `tenjin config set update.mode nudge`.

Every install runs as a binary or `node <script>` and never through a shell,
which is also the only form win32 can spawn, bounded by a 5 minute budget, from
the home directory, with the manager's output sanitized before it reaches a
terminal. `tenjin update` is documented as never-allowlisted for agents: it
replaces the binary the agent then runs.
