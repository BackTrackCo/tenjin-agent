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
