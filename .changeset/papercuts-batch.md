---
'tenjin-cli': patch
---

Small fixes across the CLI:

- The wallet address QR code scans on light editor themes: it is drawn from fixed 256-color black and white with the spec's four-module margin, and is skipped (the address still prints) on a terminal without 256 colors.
- `tenjin payments` lists the paid lookups this machine made: time, provider, service, amount, settlement and transaction. `payments reconcile` is unchanged.
- The routing deposit reads as prepaid credit, not spend. `tenjin status` shows lookups and routing credit apart (prepaid, what is left, about how many calls) and what counts toward the daily limit; `tenjin wallet balance` adds the credit left. The call that takes a deposit says so once. It still counts toward the daily limit.
- A paid job still running when its time runs out, whose seller sent a status URL (`X-Status-Url`), is reported as still running with that URL to check, settlement unknown, instead of as a failure.
- Every funding hint names the same amount, `tenjin wallet fund 5`, the checkout's Apple Pay and Google Pay minimum.
- The request tool's description says it also generates images, voice, music, sound and video.
- A wallet too low to pay says how much USDC it is short.
- A `tenjin install --project` install is refreshed by `tenjin update`, from its own directory; `install --project` records it.
- A bare `tenjin doctor` in a project installed with `--project` checks that install, and the install names `tenjin doctor --project`.
- A bare `tenjin uninstall` in such a project says it left the project's install in place and names `tenjin uninstall --project`.
