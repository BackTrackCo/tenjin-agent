---
'tenjin-cli': patch
---

`tenjin doctor` names the layer that refused the router probe: a proxy, DNS,
TLS, the connection, or a 401/403 that a proxy sent instead of the origin. On
the production base URL it no longer tells you to set the base URL you already
have. `tenjin install` runs the same probe at the end and prints a warning when
the router does not answer. The install still succeeds.

When `tenjin install` cannot ask (`--json`, or a shell with no terminal, which
is how an agent runs it), it no longer writes `maxAutoSpend`. Its output holds
the question for the agent to ask you and the command for each answer
(`spend.approval` in `--json`). The agent runs `tenjin config set maxAutoSpend
0.25` only if you say yes. Until then, the router pays for nothing on its own.
The daily limit is still filled, because it can only narrow spending.

The install report no longer names a `hooksDir` for the router's hook entries,
which are plain commands and use no directory. The README now lists everything
the router sends, including the questions your agent asks you and your answers.
