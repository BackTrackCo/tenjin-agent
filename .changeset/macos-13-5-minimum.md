---
'tenjin-cli': patch
---

Tenjin now says up front that it needs macOS 13.5 or newer, the oldest macOS its pinned Node 24 runs on. `tenjin install` and the shell installer refuse an older Mac before downloading or changing anything, where install used to download Node and then fail.
