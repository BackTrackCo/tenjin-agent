---
'tenjin-cli': patch
---

A DeepSeek worker's web search now works and no longer ends the job. Tenjin answers the worker's native WebSearch itself with Exa search at its lite tier, $0.004 a search with no routing fee, paid from your Tenjin wallet within your per-call limit and daily budget and counted against the job's ceiling, so it shows in the job's spend and end line and in `tenjin payments`. A search the job's ceiling or your limits cannot cover, or that the router does not offer, returns a plain error to the worker's WebSearch and the job continues. WebFetch stays native; when its local fetch fails, Tenjin reads the public page through Exa page read for $0.001, paid and counted the same way. Any other request the worker's Claude Code makes that Tenjin cannot send now fails alone, as that request's API error, instead of ending the job; a failed or uncertain paid model call still ends it.
