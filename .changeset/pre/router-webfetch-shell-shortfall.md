---
'tenjin-cli': minor
---

A WebFetch that came back as an empty shell now counts as falling short. A
JavaScript app (app.uniswap.org came back as its title, "Uniswap Interface")
and a YouTube page (its footer links only) both answer 200 with tens of
kilobytes, so the size rule never fired and the agent was left with neither the
page nor an offer. The after-call hook now reads the opening of WebFetch's own
summary for a page that was empty, only a title, navigation or a footer, or
needed JavaScript, and sends `nativeOutcome.reason: "no_main_content"` beside
the code and size so the router can pick a page reader that renders it. Over
682 recorded 2xx WebFetch results the rule matched the eight shells and nothing
else. A router that predates `reason` refuses the packet, which the hook reads
as silence, as before.
