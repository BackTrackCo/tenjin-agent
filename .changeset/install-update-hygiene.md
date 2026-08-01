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

`tenjin install` also stopped taking local files silently. It replaces a skill
directory wholesale so the packaged copy is exactly what lands, but the warning
said "local skill copy differed and was overwritten" while a `references/`
folder beside the SKILL.md was deleted without being mentioned, and "differed"
was false whenever the shared files were byte-identical. The warning now names
every file the wipe removes and only claims a difference when there is one. A
symlinked skill directory is resolved before the wipe, so a dotfiles-managed
directory keeps its link instead of being replaced by a real one with an
orphaned target. An unwritable skills directory raises a typed error with a fix
rather than a bare `EACCES ... mkdir` under INTERNAL with none.

The "hosted skill was already here" notice now fires only for the
hosted-zero-install-first funnel. It gated on a SKILL.md being on disk, which is
trivially true on any re-run, so the CLI reported its own mirror back to the
user as something they had installed. `hostedArrivedFirst` is the narrowed
signal; `hostedPreexisting` keeps its meaning in the envelope. The note also no
longer reads as though the local hosted file was preserved when it was replaced.
