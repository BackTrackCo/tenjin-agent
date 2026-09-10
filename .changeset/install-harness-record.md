---
'tenjin-cli': patch
---

`install` now detects Claude Code and Codex, shows what it found, and asks which
real harnesses to wire. Repeated `--harness claude|codex` flags express the same
selection without a prompt for non-interactive use; `shared` is no longer a
harness value. Skill destinations are deduplicated separately from hook targets,
so two harnesses can share a skills directory without one silently erasing the
other's hook registration. The settled selection is recorded under
`install.harness` in the global config (written by `install`, not a `config set`
key, and replaced rather than unioned by a later selection), and the `skills`
check treats that settled selection as authoritative. Homes without a selection
record still fall back to current detection. Its `--json` data carries the
per-directory `requested` flag next to `harnessPresent`, which still means "a
harness detected here reads this".

Doctor's repair command names the selected harness, or each detected harness on
a home that predates the selection record, instead of suggesting a bare
`tenjin install` that would prompt again.

This intentionally changes scripted installs: a bare `tenjin install` in a
non-interactive shell now refuses before writing unless it receives one or more
explicit `--harness claude` / `--harness codex` flags, instead of silently
targeting the shared skills directory. Existing `install --refresh` calls,
including those started by `tenjin update`, remain prompt-free and unaffected. A
persisted legacy `shared` selection is read as `codex`, its lossless replacement,
so upgrading does not invalidate config.
