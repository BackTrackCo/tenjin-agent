---
'tenjin-cli': patch
---

The spawned daemon now inherits `NODE_USE_ENV_PROXY` alongside the proxy
addresses it already inherited. Node reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
for `fetch` only when that flag is set, so on a machine where a proxy is the
only route out the daemon held the addresses and dialled hosts directly. It
forwards the value you set and nothing more: with no proxy env, nothing changes.
