---
'tenjin-cli': patch
---

Draw DeepSeek subagents like native ones in Claude Code. A held Agent call shows as a Tenjin offer with its cap, not as a finished subagent with zero counts. An accepted worker is one live row with its tool uses, tokens, time and the spend settled so far, its latest step under it, and a native `Done (…)` line when it ends; the spinner names the worker's step while it runs. The row and the activity viewer read a local display file the CLI writes while the worker runs and removes when it ends, and the worker no longer waits for its viewer to start. Worker handbacks now report tool uses and tokens. Charges, quotes and settlement are unchanged.
