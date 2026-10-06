---
'tenjin-cli': patch
---

`tenjin doctor` names the layer that refused the router probe: a proxy, DNS,
TLS, the connection, or a 401/403 that a proxy sent instead of the origin. On
the production base URL it no longer tells you to set the base URL you already
have. `tenjin install` runs the same probe at the end and prints a warning when
the router does not answer. The install still succeeds.

An install with no terminal (a script, CI, or an agent) no longer writes
`maxAutoSpend`. The bare CLI's zero holds, so every paid lookup needs your
approval until you run `tenjin config set maxAutoSpend 0.25`. The daily limit is
still filled, because it can only narrow spending.

The install report no longer names a `hooksDir` for the router's hook entries,
which are plain commands and use no directory. The README now lists everything
the router sends, including the questions your agent asks you and your answers.
