---
'tenjin-cli': minor
---

Skills self-heal after a CLI update: the first command run under a new version
refreshes the wired harness skills to the packaged copies and removes any skill
the package stopped shipping, with a one-line notice at a TTY. It never affects
the triggering command's output or exit code, and a failed pass leaves the old
stamp so the next command retries.

What it may touch is bounded by consent, not by a scan. `tenjin install` is the
only thing that grants ownership of a directory: it records the exact paths it
wired in `~/.tenjin/skills-sync.json`, and the self-heal writes to those and no
others. A machine that ran `tenjin install --harness claude` therefore keeps its
shared `~/.agents/skills` untouched, including a `tenjin` mirror fetched by hand
from tenjin.blog. Within a recorded directory it still only touches names Tenjin
ships or once shipped, and it never creates a directory that is not already
wired.

A machine with Tenjin skills but no such record is never adopted, because the
files cannot prove who put them there: `npx skills add BackTrackCo/tenjin-agent`
installs the same adapter skills, and overwriting another installer's copies is
not ours to do. Those machines get one line at a TTY, once per CLI version, that
says skills from an earlier install were found and `tenjin install` enables
automatic updates. Nothing is written to the skills themselves, and a machine
with nothing wired says nothing at all.

Each directory is replaced transactionally: the new tree is built in a sibling
temp directory and swapped in by rename, and the parked old copy is restored by
the next run if a crash lands in the window between the two renames, so a
harness never sees a partial or missing skill. The whole pass is serialized on a
lock file that `tenjin install` takes as well, so wiring and healing cannot
interleave and the recorded directory list can never be overwritten with a stale
one. A lock left behind by a crashed process is reclaimed after ten minutes
rather than blocking every later command forever.
