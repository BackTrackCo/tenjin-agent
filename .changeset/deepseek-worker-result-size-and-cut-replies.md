---
'tenjin-cli': patch
---

A DeepSeek worker's model call the router cut (504 `model_stream_idle` or `model_deadline_exceeded`) now has its receipt read at once, as a call DeepSeek failed has: when the router's record says nothing was charged, its quote is released then, not at a later reconciliation. Such a call is never tried again. A Messages call now states the reply size the worker reads (`maxResultBytes`, 4,000,000 bytes) to a router whose offer says it honours one; to any other router, production today included, it states nothing and reads 2,000,000 bytes as before.
