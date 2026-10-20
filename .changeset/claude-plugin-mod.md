---
'tenjin-cli': patch
---

The `tenjin` Claude Code plugin now carries a mod (Claude Code 2.1.287 or later). Each paid lookup is one transcript line drawn as Claude Code draws an MCP call: while it runs, `⏺ Calling Exa search… · $0.007` with the query under it, and once it ends the dim `Called Exa search · $0.007 (ctrl+o to expand)`, which the ctrl+o transcript opens into the whole row with what came back. Several takes show what they all paid. A call that failed after paying shows the error dot, the amount and the state. A call the router sends back for a missing field, and the router's own free calls, draw nothing. A WebSearch or WebFetch held for a Tenjin offer shows as its native row struck through, `~~Web Search~~("best local LLM") · Tenjin offered Exa search`, and becomes, once the `request` call takes it up, `⏺ Exa search("best local LLM") · $0.007` in place. The mod reads only the kept spec and the offer record, and writes nothing under `~/.tenjin`.

Without the mod too: `tenjin hook alive` says at session start when the wallet holds less than the per-call limit, and the request tool stays out of tool search through `anthropic/alwaysLoad`.
