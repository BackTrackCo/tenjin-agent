---
'tenjin-cli': patch
---

The router now asks for each offered service's display name (`accepts` gains
`label`) and keeps it on the spec it stores, so the Claude Code mod can show
`Calling Exa search…` instead of a provider or host. A spec without a label
parses as before, and a server that does not send one changes nothing.
