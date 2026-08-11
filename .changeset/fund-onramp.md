---
'tenjin-cli': minor
---

Card-fund the wallet from the terminal. `tenjin fund [amountUsd]` signs a SIWX
proof with the wallet's own key, asks the Tenjin backend to mint a Coinbase
Onramp checkout URL for that same address, prints it, opens it in the default
browser, and polls the Base USDC balance until the purchase lands (`--no-open`
and `--no-wait` opt out). The link is single-use, expires in about five
minutes, is bound to this machine's network, and requires a Coinbase account
to complete; only `https://pay.coinbase.com` URLs are ever opened. Human-only
like `send`: the verb is pinned off the MCP surface.
