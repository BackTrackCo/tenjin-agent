---
'tenjin-cli': minor
---

Rebuild the `tenjin install` walkthrough around three questions and a five-line
summary. It used to print the whole security reference (the allowlist block, the
`--base-url` flag caveat, the session-key notes, the MCP caveat) in the middle of
a setup flow and then leave the operator to paste nine lines into
`.claude/settings.json` by hand. That material has not changed and has not moved:
`tenjin doctor` prints it, unedited, on every run and in `--json`. Setup no longer
recites it.

What install asks now, in order, rendered as proper terminal prompts:

1. Publishing, as a three-option list with one line of consequence each. Auto is
   listed first and marked recommended ("your agent publishes clean pieces on its
   own; your harness still shows each command for approval"), then "Ask me in chat
   first", then "Fully unattended (only hard blocks stop it)". Recommending auto
   is something that happens to a human looking at the consequence: the STORED
   default is unchanged, so a non-interactive run, a cancelled prompt, or
   `--dry-run` still leaves `publish.mode` unset and resolving to `review`.
   `--publish-mode` is unchanged.
2. Permissions, a yes/no defaulting to yes: "Let your agent search tenjin without
   permission popups?" On yes, install writes the nine free-verb rules into
   `permissions.allow` in `~/.claude/settings.json` instead of printing them.
3. Wallet, unchanged: asked only when no wallet exists, skipped by `--no-wallet`.

The `~/.claude/CLAUDE.md` nudge is no longer a fourth question. `--claude-md` and
`--no-claude-md` still control it and an absent flag skips it, interactive or not.

The settings writer is additive only and consent-gated. It appends only rules that
are missing, never removes, reorders, or rewrites an existing entry or any other
key, preserves key order and 2-space formatting, writes atomically, creates the
file and the `permissions.allow` path when absent, and is idempotent (a re-run
reports everything already present and does not touch the file). A settings file
it cannot parse, or whose `permissions` / `permissions.allow` is not the expected
shape, is reported and left exactly as it is; it is never repaired or clobbered.
The rules it may write are a hardcoded constant and the writer takes no rule
argument, so no call path can make it grant `buy`, `publish`, `session start`,
`send`, `config set`, `wallet create`, `mcp`, `install`, or a blanket
`Bash(tenjin:*)`.

New flag `--allow-free-verbs` does the same write headlessly and works with
`--json`; without it a non-interactive run changes nothing and says the flag is
available. The outcome (path, added, already present, or why it was skipped) is
reported in the summary and in the envelope under `permissions.wired`, alongside
the unchanged `alwaysSafe` / `optIn` / `neverAllowlisted` tiers.

Prompts are rendered with `@clack/prompts`, bundled into the shipped output as a
devDependency in its own split chunk: published `dependencies` stays `{}`, and a
`search` or `doctor` run never parses it. Every prompt sits behind an injectable
seam, so the machine contract is untouched: under `--json` or a pipe, install asks
nothing and emits the same envelope it did before.
