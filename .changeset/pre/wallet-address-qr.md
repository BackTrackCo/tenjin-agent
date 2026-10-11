---
'tenjin-cli': patch
---

`tenjin wallet show` and `tenjin wallet fund` draw the wallet address as a QR code at
a terminal, with `USDC on Base (eip155:8453)` under it, so a phone wallet can scan it
and send USDC. `tenjin wallet address` is a new name for `wallet show`. The code
encodes the plain EIP-55 address and is drawn black on white in 33 columns. It is
skipped with `--no-qr`, with `--json`, when stdout is not a terminal, when the
terminal is narrower than the code or cannot show color (`NO_COLOR`, `TERM=dumb`). The
JSON output is unchanged.
