---
'tenjin-cli': patch
---

Hook noise fixes (tenjin-agent#211):

- The push failure arm fires only behind build/test/migrate/install/lint command heads (never `which`, `grep`, `test`, `diff`, `ls`, or `git diff --exit-code`, which exit 1 to mean "no"), and only on a real error marker in the output tail (`FAIL`, `AssertionError`, `N failed`, `Error:`-class lines, tracebacks, `exit code N`, errno codes, toolchain prefixes) rather than prose words like "error", "failed" or "not found". Stderr chatter with no marker is success. `which codex` no longer injects an unrelated note.
- A lookup bucket that is full is recorded once per window; the session remembers when it refills, and later capped fires on that arm exit without a ledger row or a 256 KB ledger-tail parse. Interim until the state store in #209.
