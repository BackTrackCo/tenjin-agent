---
'tenjin-cli': patch
---

`tenjin update` and the background auto-update now install a release only when npm's build provenance shows Tenjin's own release workflow built it, with the same sha512 as the tarball, whether the update runs through Tenjin's runtime or through npm. A release without that provenance is refused before anything is downloaded or installed, and the version you have keeps running.

The background auto-update also takes a release only once npm published it at least a day ago, so a bad release can be pulled before any machine runs it on its own; until then it switches nothing and `tenjin doctor` says why it waited. A manual `tenjin update` still takes the newest release right away. The background update does not run at all while `NODE_TLS_REJECT_UNAUTHORIZED=0` turns off TLS certificate checks, since anyone on the network path could then answer for npm; `tenjin doctor` says so and suggests `NODE_EXTRA_CA_CERTS` for a corporate certificate instead.
