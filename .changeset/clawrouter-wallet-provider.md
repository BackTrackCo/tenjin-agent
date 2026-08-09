---
'tenjin-cli': minor
---

Add `tenjin wallet connect clawrouter` to reuse ClawRouter's existing funded EVM
wallet. The provider reads `~/.openclaw/blockrun/wallet.key` before the
`BLOCKRUN_WALLET_KEY` fallback, never reads the mnemonic, pins the connected
address against signer drift, and refuses raw transaction signing. Wallet schema
v3 stores only the provider and address while remaining compatible with local
wallet schema v2.
