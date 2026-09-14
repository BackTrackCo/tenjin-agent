---
'tenjin-cli': patch
---

Fix the failure arm reading a vitest stack pointer as a runner header. vitest's
default reporter spends its `❯` glyph twice, on the file summary that opens a
run's report and on every source pointer inside a failure's stack, so the block
walk in `errorLine` stopped at the pointer and never reached the `FAIL` header or
the `AssertionError:` line above it. Every vitest failure keyed a null `sig_v1`
and fired the fingerprint leg only, never the text-search leg. A `❯` line whose
remainder is a bare `file:line:col` no longer counts as a block boundary.
