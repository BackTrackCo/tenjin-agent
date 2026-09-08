---
'tenjin-cli': minor
---

Codex runs the same loop. `tenjin install` on a machine with Codex writes seven `command` entries to `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`), all through the shim, beside the Claude Code set; `doctor` reports them as configured, trusted in Codex (`[hooks.state]` in config.toml, which only `/hooks` writes) and observed in the ledger; `uninstall` removes only the entries it wrote. The daemon serves `/hook/codex` with an adapter built on payloads captured from codex-cli 0.153.4: root prompt lookups, per-child identity through `agent_id`, multi-file `apply_patch` edits marked in one fire, and the capture ask delivered as a Stop `decision: block`.

Shared boundary corrections that a second harness forced: the tool an arm reads is canonical (`command`, `paths`, `task`, `query`, `url`) rather than a vendor argument bag; a stored session is namespaced by harness (`claude:<id>`, `codex:<id>`), so `loop.db` state from before this release does not join new sessions; `tenjin search` stamps the thread it ran inside (`CODEX_THREAD_ID`) as `agent_id`, and the capture ask names a CLI miss only to the actor that opened it. A Codex shell result carries no exit status, so its completion stays unknown (an error marker is still a failure) and no pairing closes on it; the spawn tool's task is opaque on the wire, so no dispatch handoff runs for Codex.
