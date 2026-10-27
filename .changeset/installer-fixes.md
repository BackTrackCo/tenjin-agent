---
'tenjin-cli': patch
---

The shell installer now refuses a Mac older than macOS 13.5, the oldest its pinned Node 24 runs on, before downloading anything, and fails a download only when it stalls (under 1 KB/s for a minute) instead of after five minutes, so a slow link can finish Node's 50 MB archive. The installer templates now ship in the npm package, so tenjin.sh builds its installers from the same release npm serves, under the same provenance. On Windows, a proxy download during `tenjin install` starts `curl.exe` from Tenjin's own folder, never from the folder you ran it in.
