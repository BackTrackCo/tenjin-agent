---
'tenjin-cli': patch
---

router: sends `catalog` in place of `discovered` and `choices`. A Tenjin list
service arrives under its catalog id, with its spec's holds and output, and a
paid result's files are saved by the spec's output. Hook, tool and footer text
are unchanged.
