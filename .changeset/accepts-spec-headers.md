---
'tenjin-cli': minor
---

Routed calls now tell the router this build sends a spec's fixed request
headers, so the router can hand it a service's call that needs one. The first
is Exa search with Dynamic Highlights: the spec carries Exa's
`Exa-Beta: dynamic-highlights-2026-08-28` opt-in and asks for one shared
5,000-character highlight budget across the results instead of 500 characters
per page, at no extra charge. Until the router ships that call, every answer
stays as it is.
