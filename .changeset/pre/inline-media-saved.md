---
'tenjin-cli': patch
---

A paid third-party service that returns its file inline, as base64 inside its
JSON (`b64_json`, a `data:` URI, an `audio_base64` field), now has that file
saved under `~/.tenjin/downloads/`, the way a linked file already was. The
`request` tool's result replaces the base64 with a note naming the saved path,
its type and its size, and lists the file in `savedFiles` and the paid ledger.
Before, a four-second video reached the agent as 4.2 MB of base64 with nothing
saved. A short string that only looks like base64, such as an id or a hash, is
left alone.
