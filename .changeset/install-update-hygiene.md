---
'tenjin-cli': patch
---

Three things that made an ordinary update or re-install read as breakage.

`tenjin install` no longer asks for permissions it already has. The consent
question fired unconditionally and the "already allowed" outcome was only
discovered by attempting the write, so every re-run interrupted the operator to
re-authorize a write that would not happen and then told them nothing changed.
A new read-only `inspectFreeVerbRules` probe answers the question first; a
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

`tenjin install` no longer removes anything. It replaced each skill directory
wholesale, so a `references/` folder or a note beside the SKILL.md was deleted,
and the directory being replaced meant a symlinked one was severed and a
dangling one silently became a real directory. It now writes the files the
package ships and touches nothing else, which is what npm, dpkg and Homebrew
do: own your files, not the directory. That is also why a byte-identical
SKILL.md beside a user's own file now reports `up-to-date` instead of
`updated`. A symlinked skill directory is written through, keeping the link, and
a broken one fails with a fix naming it rather than a raw ENOENT. This is safe
to do without a manifest only because each skill is a single file; a test pins
that, so the day one grows a second file the build says so.

The "hosted skill was already here" notice now fires only for the
hosted-zero-install-first funnel. It gated on a SKILL.md being on disk, which is
trivially true on any re-run, so the CLI reported its own mirror back to the
user as something they had installed. `hostedArrivedFirst` is the narrowed
signal; `hostedPreexisting` keeps its meaning in the envelope. The note also no
longer reads as though the local hosted file was preserved when it was replaced.

A symlinked skill directory is now REFUSED rather than replaced. Following the
link and wiping the target destroys whatever the operator manages there, and
removing the link detaches the path they set up; neither is the CLI's to pick
silently, so nothing is written and the operator is told what to change. A
dangling link is refused too, instead of reading as absent and being replaced by
a real directory. The removal list also covers non-regular entries, which the
tree reader does not carry but the wipe still takes, and filenames are sanitized
before they reach a message.

Concurrent `tenjin install` runs no longer race. Each skill directory is replaced
by rm-then-write with nothing serializing them, so five simultaneous runs failed
7 times out of 15 on raw `ENOENT`/`ENOTEMPTY` renames, and one of the failures
told the operator to check directory permissions for what was purely a race. The
wiring now takes the skills lock (0 of 15 failures), a contended lock reports as
REFUSED naming the lock file rather than escaping as an untyped timeout, and the
remaining errno paths carry a fix. An interrupt during the write releases the
lock and says what state the machine is in, instead of exiting 130 with no output
and stranding the lock for every later run.

`tenjin doctor` now reports skills that are wired but not from this build.
Updating the CLI does not update the copies install wrote, and every existing
check passed the whole time an agent was reading an older version's instructions.
Only the CLI adapters are compared, and only in directories a harness on this
machine actually reads: the hosted mirror may legitimately be a newer fetch from
tenjin.blog, and a leftover directory nobody reads is nobody's problem.

The permissions writer refuses rather than clobbers. It is a whole-file
read-modify-write, so a change landing between the read and the rename was erased
in full, including keys with nothing to do with permissions. Claude Code writes
that file too, so the competing writer is not hypothetical. The bytes the edit was
based on are compared immediately before the commit, and a file that moved
underneath is left alone with a warning to re-run.

A non-regular file at a shipped skill path is refused instead of read. `readFile`
on a FIFO blocks until a writer appears, so a pipe left at a SKILL.md path hung
`tenjin install` past SIGTERM until it was killed outright, and a character device
would have streamed unbounded bytes into memory. Neither call fails, so no errno
mapping could have caught it.
