---
'tenjin-cli': minor
---

`tenjin install` is now a real onboarding walkthrough. At an interactive terminal
it prints a plain, one-screen setup (skills installed per harness, a publish-mode
question, optional wallet creation with the address and funding steps, and a
one-line health check) instead of a JSON blob, and it can create and set up your
wallet in the same flow. Pass `--json` (or pipe it) for the unchanged machine
envelope, and `--no-wallet` to skip the wallet step.
