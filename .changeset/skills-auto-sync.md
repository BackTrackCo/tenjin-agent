---
'tenjin-cli': minor
---

Skills self-heal after a CLI update: the first command run under a new version
refreshes the wired harness skills to the packaged copies and removes any skill
the package stopped shipping, with a one-line notice at a TTY. It never affects
the triggering command's output or exit code, and a failed pass leaves the old
stamp so the next command retries.

What it may touch is bounded by consent, not by a scan. `~/.tenjin/skills-sync.json`
records the CLI version that wired the skills AND the exact directories it wired,
and the self-heal writes to those directories and no others. A machine that ran
`tenjin install --harness claude` therefore keeps its shared `~/.agents/skills`
untouched forever, including a `tenjin` mirror fetched by hand from tenjin.blog.
Within a recorded directory it still only touches names Tenjin ships or once
shipped, and it never creates a directory that is not already wired.

Machines that ran `tenjin install` before this shipped have no stamp, and they
are exactly the ones going stale, so they are adopted once from evidence on disk:
a directory counts only if it holds one of the CLI adapter skills, which nothing
but `tenjin install` places. A hosted-only `tenjin` copy is not evidence and is
left alone, and a machine with nothing wired is left unstamped, so `tenjin
install` remains the first thing that ever consents.

Each directory is replaced transactionally: the new tree is built in a sibling
temp directory and swapped in by rename, so a crash mid-update leaves the whole
old copy or the whole new one, never a half-written skill a harness would load.
The whole read-resync-stamp pass is serialized on a lock file, so two first
commands after an update cannot interleave one's swap with the other's stamp.
