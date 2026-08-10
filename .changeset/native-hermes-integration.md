---
'tenjin-cli': minor
---

Add a working native Hermes Agent integration. `tenjin install --harness hermes`
now installs the Tenjin skills, adds a conservative MCP entry, and enables a
stdlib-only Hermes plugin that checks Tenjin before `web_search`, attaches a hit
to that tool's result, and surfaces unresolved searches through
`transform_llm_output` for publish-back.

Hermes reuses the same generated, bounded, fail-open retrieval/store/nag scripts
as Claude Code instead of carrying a second payment-facing implementation. The
installer honors an absolute `HERMES_HOME`, embeds absolute executable paths,
preserves unsupported or user-owned YAML byte-for-byte, never overrides
`plugins.disabled`, keeps automatic detection inert until explicit activation,
and adds a warn-level doctor check. It adds no `TENJIN_HARNESS` policy selector
and does not copy or couple wallet state.

Two consent decisions stay separate. `--no-hooks` and `--search-hooks off` now
withhold the Hermes scripts, plugin, and activation, the same way they withhold
Claude's `settings.json` entries; the `mcp_servers.tenjin` entry is a server
registration and is still written. Where the plugin is held back by the stored
`hooks.searchMode`, install and `tenjin doctor` name
`tenjin config set hooks.searchMode auto` rather than the install command that
cannot move the blocker.

Re-pointing the MCP entry (an nvm switch, a pnpm-vs-npm global) now rewrites the
managed block in place instead of appending a duplicate marker comment and
deleting a neighbouring comment. `tenjin doctor` no longer aborts on a relative
`HERMES_HOME` set for some other tool, reports a baked MCP command that no longer
exists as stale rather than green, and shares the installer's classifier so its
fix cannot point into a conflict it did not predict.
