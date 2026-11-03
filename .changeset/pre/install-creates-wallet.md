---
'tenjin-cli': patch
---

`tenjin install` creates your wallet again when there is none, and ends with a
short summary: set up, your wallet address, the spend limits, and the next step
(`tenjin wallet fund`, then restart Claude Code). `--no-wallet` skips the wallet.
The package no longer ships a `prepare` script, so `npm i -g tenjin-cli` prints
no install-script warning.
