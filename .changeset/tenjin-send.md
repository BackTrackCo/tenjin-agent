---
'tenjin-cli': minor
---

`tenjin send <amount> <token> <to>`: an explicit escape hatch to move USDC on Base out of the agent wallet. Previews the resolved (checksummed) recipient and exact amount, requires an interactive confirm or `--yes` before anything is signed, refuses when the active wallet's passphrase entry is missing, and prints the tx hash on success. Signs through the same TenjinSigner/WalletProvider seam as `buy` (the seam gains `signTransaction`); deliberately excluded from the MCP toolset and the skill adapters.
