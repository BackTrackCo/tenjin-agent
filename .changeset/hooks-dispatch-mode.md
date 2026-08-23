---
'tenjin-cli': patch
---

`hooks.dispatchMode` gives the subagent-dispatch hook its own switch. The default, `inherit`, follows `hooks.searchMode` as before; `remind` or `off` keeps every subagent prompt on the machine while the WebSearch hook stays on `auto`, and `auto` does the reverse. Runtime config, read on every hook run: `tenjin config set hooks.dispatchMode remind` takes effect immediately with no re-install and nothing asked at install time.
