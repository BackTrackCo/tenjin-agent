---
'tenjin-cli': patch
---

A paid read of a public link no longer stops at "the query carries a credential-shaped value". Queries stopped masking any long letters-and-digits path segment, which also caught Reddit slugs, Google Docs and Drive ids, gists, Loom shares and Notion pages and sent nothing. A query still masks an RPC provider key in a URL path (QuickNode, Alchemy, Infura, Ankr, Chainstack, GetBlock, dRPC, Tenderly) and a webhook token in one (Slack, Discord, Make), along with vendor tokens, credential query parameters, bearer tokens and connection strings.
