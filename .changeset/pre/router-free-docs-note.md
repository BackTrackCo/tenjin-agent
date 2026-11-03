---
'tenjin-cli': patch
---

Suggest the free docs lookup after a search instead of fetching it. When the router sends a free lookup before a WebSearch as a note, the search runs as written and one optional line after it names the lookup; your assistant calls it or not. Any other free offer before a search stays silent, so the server decides when the line shows. Nothing is fetched or added to the search results, and a called lookup draws like every other Tenjin lookup, with `free` where the price goes.
