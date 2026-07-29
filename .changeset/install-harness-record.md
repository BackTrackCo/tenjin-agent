---
'tenjin-cli': patch
---

`install --harness <target>` is now remembered, so `doctor` keeps judging the
directory you named. Detection only sees the harnesses the CLI probes for, and
`~/.agents/skills` is the cross-harness Agent Skills location, so an explicit
`--harness shared` on a Claude-only machine used to be a target for that one run
and invisible to every later check — including for a shadowed `tenjin-publish`
sitting in the directory the user chose. The explicit set is recorded under
`install.harness` in the global config (written by `install`, not a `config set`
key, and replaced rather than unioned by a later explicit run), and the `skills`
check treats a recorded directory as in play alongside the detected ones. Its
`--json` data carries the new per-directory `requested` flag next to
`harnessPresent`, which still means "a harness detected here reads this". A
leftover directory that is neither detected nor requested is still described
rather than warned about.

When NOTHING is wired anywhere, the `fix` now also names a recorded
`install.harness` target instead of always suggesting a bare `tenjin install`:
before, that first run wired `.claude` only, and a second `doctor` was needed
to learn about `--harness shared`.
