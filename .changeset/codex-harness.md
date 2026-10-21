---
'tenjin-cli': patch
---

`tenjin install --harness codex` sets up Tenjin in Codex: the wallet, the spend limits and the Codex plugin `tenjin` through `codex plugin marketplace add` and `codex plugin add` from the package's `dist/hosts/codex`. Its spend limits follow the same defaults as Claude Code: with no answer the defaults ($0.25 a call, $5 a day) hold and the spend question comes back in `nextSteps`, and `--max-auto-spend` (at least 0.25) and `--session-budget` set your own. The plugin's hooks route your prompt and one web search before it runs and after, its `router` server carries the request tool, named `mcp__router__request`, and a `PermissionRequest` hook allows that tool without a prompt (turn it off in `/hooks` to be asked first). Codex asks you to trust the four hooks in `/hooks`. The plugin carries no version, so its hooks keep their trust across `tenjin update`. `tenjin doctor --harness codex` reads Codex's one hook list for the plugin and its trust, and whether a Pay once ask can show, and writes nothing. `tenjin uninstall --harness codex` removes the plugin and its marketplace.

Every router request now names its host in `harness` (`claude` or `codex`), on the hook, tool and outcome bodies, so the router can leave out a lookup the host's own tools already do.
