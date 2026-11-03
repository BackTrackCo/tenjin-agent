---
'tenjin-cli': minor
---

Card-fund the wallet from the terminal. `tenjin fund [amountUsd]` signs a SIWX
proof with the wallet's own key, asks the Tenjin backend to mint a Coinbase
Onramp checkout URL for that same address, prints it, opens it in the default
browser, and polls the Base USDC balance until the purchase lands (`--no-open`
and `--no-wait` opt out). The link is single-use, expires in about five
minutes, is bound to this machine's network, and requires a Coinbase account
to complete; only `https://pay.coinbase.com` URLs are ever opened. A matching
`tenjin_fund` MCP tool mints the link and returns it for the agent to hand to
the human (no browser open, no poll; minting moves no money and the payment
itself happens on Coinbase's authenticated page). `send` stays off MCP.

The link goes to stderr the moment it is minted, on every surface, because the
stdout envelope that also carries it is written only after the poll and the link
does not live that long. Opening a browser and polling are interactive
behaviours: both default off when stdout is not a TTY, so a piped, `--json`, or
MCP run returns as soon as the link exists. `pollStatus` on the envelope
distinguishes `skipped`, `unavailable`, `timed-out` and `arrived` instead of
collapsing three of them into `funded: false`. `tenjin fund` is never
allowlisted for Bash: a prefix rule would clear `--base-url` with it, which the
MCP tool's amount-only input does not.
