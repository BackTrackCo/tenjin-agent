---
'tenjin-cli': patch
---

DeepSeek consent now names Exa beside Tenjin and DeepSeek, since a worker's web searches and the address of a page its WebFetch could not fetch go to Exa. Your `tenjin config block` and `only` rules now apply to a worker's Exa searches and page reads as they apply to what Tenjin picks on its own: one that leaves Exa out refuses them with nothing paid. An `Explore` worker starts without your CLAUDE.md and rules files, as a native `Explore` subagent does. A worker's settings, which hold its GitHub token, now reach the Claude Agent SDK only as a private file's path, so the SDK's debug log (`DEBUG_CLAUDE_AGENT_SDK`) no longer records the token.
