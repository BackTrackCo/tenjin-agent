---
'tenjin-cli': patch
---

In Claude Code, a paid service Tenjin offers when you send a prompt now shows as one dim line under that prompt, `⎿  Tenjin offered Exa search`, before the agent calls it. The line says only that it was offered, so it stays true whether or not the agent takes the offer. A free lookup, an offer with no service name, and an offer made in place of a WebSearch or WebFetch (which names the offer on its own row) draw no line. The prompt hook keeps the offer it made in the offer record the mod already reads, keyed by the prompt.
