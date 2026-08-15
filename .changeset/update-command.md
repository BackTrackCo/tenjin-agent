---
'tenjin-cli': minor
---

Self-update from the CLI, and tell agents when to use it.

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

The daily check now reaches agents, not just humans. Alongside the dim stderr
line a TTY gets, a newer version appears as `update_available` (with `current`
and `latest`) on the JSON envelope and on the generated hook scripts' output, so
the agent driving a command can run `tenjin update` itself at a moment it picks.
Nothing installs on its own: a CLI that starts a fresh process per invocation
has no deferred-activation window to hide a binary swap in, and a silent version
swap reshapes output exactly where nobody is watching. New `update.mode` config
key, `nudge` (default, all three surfaces) or `off` (none, and no request to
npm). The field is read from the check's cache, so it costs no request and no
delay on the command carrying it.

Every install runs as a binary or `node <script>` and never through a shell,
which is also the only form win32 can spawn, bounded by a 5 minute budget, from
the home directory, with the manager's output sanitized before it reaches a
terminal. `tenjin update` is documented as never-allowlisted for agents: it
replaces the binary the agent then runs.
