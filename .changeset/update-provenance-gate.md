---
'tenjin-cli': patch
---

`tenjin update` and the background auto-update now install a release only when npm's build provenance shows Tenjin's own release workflow built it, with the same sha512 as the tarball, whether the update runs through Tenjin's runtime or through npm. A release without that provenance is refused before anything is downloaded or installed, and the version you have keeps running.
