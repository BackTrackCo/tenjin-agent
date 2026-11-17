---
'tenjin-cli': patch
---

A DeepSeek worker whose model call through Tenjin returns no result now ends with that cause: `status: "stopped"` and `endedBy` `model_call_failed`, `model_call_timeout`, `payment_refused` or `budget`, a sentence in plain words, the router's HTTP status or the payer's code when one is known, and the worker's last text, in place of `status: "unknown"` with no cause. Its row ends `Model call failed (…)`, `Model call timed out (…)` or `Payment refused (…)`. Any other stop with a known cause also reads `stopped`.
