---
'tenjin-cli': patch
---

Three things that made an ordinary update or re-install read as breakage.

`tenjin install` no longer asks for permissions it already has. The consent
question fired unconditionally and the "already allowed" outcome was only
discovered by attempting the write, so every re-run interrupted the operator to
re-authorize a write that would not happen and then told them nothing changed.
A new read-only `pendingFreeVerbRules` probe answers the question first; a
settings file that cannot be read is "unknown" rather than "already allowed", so
that case still asks and the writer still reports why.

The "hosted tenjin skill was already here" notice names its directory. It is
emitted once per harness, and a user who arrived through the hosted zero-install
skill has it in both, so the run printed two byte-identical lines that read as
the CLI stuttering.

A session cache written by an older CLI is reported as outdated, not corrupt.
`origin` became required after existing caches were written, so those files
failed the schema and `doctor` announced "could not be parsed" on every run,
forever, over a file that is re-minted by one command and is usually expired
anyway. It now has its own state, reported at the same standing as an absent
cache with the verb that refreshes it. The discriminator is an allowlist of
fields added after the shape shipped, ANDed with the key genuinely being absent,
so a missing private scalar and a field that is present and wrong both stay in
the tamper bucket.
