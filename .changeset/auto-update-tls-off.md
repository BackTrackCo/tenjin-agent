---
'tenjin-cli': patch
---

The background auto-update no longer runs while `NODE_TLS_REJECT_UNAUTHORIZED=0` turns off TLS certificate checks, since anyone on the network path could then answer for npm; `tenjin doctor` says so and suggests `NODE_EXTRA_CA_CERTS` for a corporate certificate instead.
