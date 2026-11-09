---
'tenjin-cli': patch
---

`tenjin pay` and the router's job polls answer a seller's own sign-in challenge on a 402 that offers no payment, as the status URL of a paid Monid run does, so a run already paid for can be collected. They sign only when the challenge names the URL that sent it and this wallet paid that host in the last 7 days, and they pay nothing on that path; `--quote` marks such a 402 with `signIn: true`. `tenjin pay` saves a binary body (an image, a sound, a PDF) to a file and returns its path in `savedTo` instead of garbled text, and waits for its printed output to reach the reader before it exits, so a large body piped to another program is no longer cut at 64 KB. A paid call that fails keeps the seller's reason for refusing the payment (`paymentError`) and reads the authorization on-chain, so a call that failed after the seller took the money shows as charged (`settlement: "settled"`). Every direct `tenjin pay` that signs is now listed in `tenjin payments`.
