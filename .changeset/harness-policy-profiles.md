---
'tenjin-cli': minor
---

Add harness-scoped policy profiles for Hermes and OpenClaw. A selected profile
can tune read auto-spend, the rolling session budget, confirmations, creator
allowlisting, and publish defaults while the wallet, spend ledger, network,
telemetry, and hard `send` cap remain shared. Profiles can be inspected or
changed with `tenjin config --profile <name>`, removed with `config unset`, and
are selected at runtime with `TENJIN_HARNESS`. Config and doctor output identify
the active profile and warn on an invalid selector; known global-only keys are
rejected inside profile data.
