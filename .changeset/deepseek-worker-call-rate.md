---
'tenjin-cli': patch
---

DeepSeek workers now keep a wallet inside the router's model-call rate, counted across every session on the machine. Against a router whose offer advertises its rate (`callLimit`), a call waits for room before its unpaid quote. Against a router that advertises none, a signed request waits for room before it leaves, at 30 calls per 60 seconds together with routing decisions, where a refusal for rate used to end the job with an uncertain call. The diagnostic record says how long a call waited (`paceWaitMs`).
