---
'tenjin-cli': patch
---

The routing fee figure comes from the server. `tenjin mcp` pays any `batch-settlement` routing quote up to a $0.01 ceiling rather than exactly $0.003, so Tenjin can change the fee without a CLI release. The deposit notice and the once-per-session notice name the fee the router's answer sends as `routingFeeAtomic`, and name no figure when it sends none. The install question, the MCP instructions and `tenjin doctor` name the ceiling. `tenjin status` drops its `~N calls` estimate, which depended on a fixed fee. The price is unchanged at $0.003.
