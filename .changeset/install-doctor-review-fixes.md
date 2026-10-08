---
'tenjin-cli': patch
---

`tenjin doctor` names the layer that refused the router probe: a proxy, DNS,
TLS, the connection, or a 401/403 that a proxy sent instead of the origin. On
the production base URL it no longer tells you to set the base URL you already
have. `tenjin install` runs the same probe at the end and prints a warning when
the router does not answer. The install still succeeds.

On Node 24.14 or newer, the CLI, its hooks (the free docs prefetch included)
and `tenjin mcp` send their requests through the proxy that `HTTPS_PROXY` or
`HTTP_PROXY` names, and honour
`NO_PROXY`. Before, Node's `fetch` ignored them unless `NODE_USE_ENV_PROXY=1`
was set. A proxy that asks for credentials (407) gets a fix that says where to
put them.

When `tenjin install` cannot ask (`--json`, or a shell with no terminal, which
is how an agent runs it), it writes no spend limit, the same as cancelling at
the question in a terminal, and sets up everything else. Its output holds the
question the terminal selector would have asked, with the same limits and
routing-fee terms, and the command for each answer (`spend.approval` in
`--json`). For a yes the agent runs the new `tenjin install --accept-defaults`,
which writes the limits shown, as the selector's "Use these limits" does, and
changes nothing else.
Until someone answers, the router pays for nothing on its own. `tenjin doctor`
shows the open question as a warning instead of failing on it, so its network
checks still print, and the first unpaid routing call in a session shows the
same question.

When a routing call cannot reach the router (DNS, TLS, a refused connection,
a proxy refusing the tunnel), every hook leg skips the router for the next 60
seconds and the native tool runs at once, instead of each prompt, search and
hand-off waiting out the gate. A slow answer, a dropped socket or an answer of
any status does not start the pause. It ends after 60 seconds, or at once
when `tenjin doctor` reaches the router; while doctor cannot, it names the
pause with the seconds left.

The install report no longer names a `hooksDir` for the router's hook entries,
which use no directory. The README keeps one sentence on
what the router sends and links to `docs/agent-permissions.md`, which lists all
of it, including the questions your agent asks you and your answers. The paid
lookup files and the `alpha.18` `~/.mcp.json` fix move to the docs too.

`tenjin doctor` and `tenjin install` warn when a running `tenjin mcp` started
before this install, so it still runs the older build and the new hooks can fail
with "Tool hook not found", and name the fix: reconnect `x402` with `/mcp`, or
start a new Claude Code session.
