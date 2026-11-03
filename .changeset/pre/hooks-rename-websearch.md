---
'tenjin-cli': patch
---

Rename `hooks.searchMode` → `hooks.webSearch` and `hooks.dispatchMode` → `hooks.agentDispatch`, both `auto|remind|off` disjoint defaults `auto`. `hooks.searchMode` (shipped in `alpha.14`) still reads as `hooks.webSearch` for one release and a legacy `off`/`remind` correctly carries to `agentDispatch` so an existing opt-out doesn't re-enable dispatch after upgrade; `hooks.dispatchMode` (including `inherit`) never shipped to npm and is kept only as a read alias for unreleased `main` testers. `HOOK_SCRIPT_VERSION 22->23`. Replaces the `hooks-dispatch-mode` changeset which described the now-removed `inherit` semantics.
