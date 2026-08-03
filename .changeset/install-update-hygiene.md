---
'tenjin-cli': patch
---

Installing, re-installing and updating the CLI each had a way of destroying
something quietly or reporting an ordinary event as breakage.

`tenjin install` no longer removes anything. It replaced each skill directory
wholesale, so a `references/` folder or a note beside the SKILL.md was deleted
and reported as "overwritten", and replacing the directory meant a symlinked one
was severed and a dangling one silently became a real directory. It now writes
the files the package ships and touches nothing else, which is what npm, dpkg
and Homebrew do: own your files, not the directory. A symlinked skill directory
or SKILL.md is written THROUGH, so the link survives and the target is what
changes; a broken link fails with a fix naming it rather than a raw ENOENT. That
is also why a byte-identical SKILL.md beside a user's own file now reports
`up-to-date` rather than `updated`, so agents reading `--json` get what humans
get. This is safe without a manifest only because each skill is a single file; a
test pins that, so the day one grows a second file the build says so.

A pipe or device at a skill path can no longer hang the CLI. `readFile` on a
FIFO blocks until a writer appears and on a character device never ends, and
neither call fails, so no error handling reached them: a pipe at a wired
SKILL.md hung `tenjin install` and `tenjin doctor` past SIGTERM until they were
killed outright. Every read of an operator-controlled skill path now goes
through one descriptor, opened non-blocking, `fstat`-checked, and read only when
it is a regular file. An unreadable file is refused rather than treated as
absent and replaced, and the permission error names the file rather than its
parent directory.

`tenjin install` no longer asks for permissions it already has. The consent
question fired unconditionally and "already allowed" was only discovered by
attempting the write, so every re-run interrupted the operator to re-authorize a
write that would not happen. A read-only probe answers first, and a settings
file that cannot be read is "unknown" rather than "already allowed", so that
case still asks.

The permissions writer refuses rather than clobbers. It is a whole-file
read-modify-write, so a change landing between the read and the rename was
erased in full, including keys with nothing to do with permissions; Claude Code
writes that file too, so the competing writer is not hypothetical. The bytes the
edit was based on are compared immediately before the commit, and a file that
moved underneath is left alone with a warning to re-run.

The "hosted tenjin skill was already here" notice now fires only for the
hosted-zero-install-first funnel. It gated on a SKILL.md being on disk, which is
trivially true on any re-run, so the CLI reported its own mirror back to the
user as something they had installed. It also names its directory, so the funnel
case reads as two facts rather than a stutter.

A session cache written by an older CLI is reported as outdated, not corrupt.
`origin` became required after existing caches were written, so those files
failed the schema and `doctor` announced "could not be parsed" on every run,
forever, over a cache that one command re-mints and that is usually expired
anyway. Every schema failure must be an allowlisted later field the file
genuinely lacks, so a missing private scalar and a field that is present and
wrong both stay in the tamper bucket.

A wallet written by a newer CLI is reported as a downgrade, not a corruption.
The record is pinned to a literal schema version, so an older binary fell
through to the generic parse failure, whose fix is "move it aside and run
`tenjin wallet create`" — advice that abandons a funded wallet. It now names
both versions and says not to delete or recreate.

Concurrent `tenjin install` runs no longer fail. Five simultaneous runs failed 7
times out of 15 on raw `ENOENT`/`ENOTEMPTY` renames, and one of the failures told
the operator to check directory permissions for what was purely a race. Removing
the wholesale directory replacement is what fixed it: each shipped file is
written through its own atomic rename, and 24 concurrent runs pass with the lock
bypassed. The wiring still takes a lock, for exclusion against the post-update
self-heal that rewrites the same paths unattended. A contended lock reports as
REFUSED naming the lock file rather than escaping as an untyped timeout, an
interrupt during the write releases the lock and says what state the machine is
in, and a lock that cannot be removed is reported rather than left for the next
run to discover as a timeout.

`tenjin doctor` now reports skills that are wired but not from this build.
Updating the CLI does not update the copies install wrote, and every existing
check passed the whole time an agent was reading an older version's
instructions. Only the CLI adapters are compared, and only in directories a
harness on this machine actually reads. When this build cannot read its own
packaged copies that is reported as unverifiable rather than as a green tick,
and the fix names the harness so it can actually clear.

An unwritable HOME, a broken link, and a wrong node type each raise a typed error
with a fix naming what to check, rather than a raw errno under INTERNAL with
none.
