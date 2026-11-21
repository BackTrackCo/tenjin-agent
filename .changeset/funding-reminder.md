---
'tenjin-cli': patch
---

When the router finds a paid tool for a step and your wallet cannot pay for it, the hook now says what the money would buy, every time: "Tenjin would have used a paid web research tool for this. Ask your agent to add funds to Tenjin." It names the kind of tool only, never the tool, its price or who is paid, and your agent's own tool still runs. This line replaces the low-balance notice for those calls. Other reasons a routing fee goes unpaid keep their once-per-session notice.
