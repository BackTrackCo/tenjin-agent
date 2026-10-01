---
'tenjin-cli': patch
---

Experimental, off by default (`tenjin config set experimental.bazaar on`):
when nothing in the curated catalog fits but a third-party pay-per-call x402
service could do the step, the router can now name that one service (who sells it, its URL, its price and the input it takes), and your
agent decides whether to use it. It calls `mcp__x402__request` with the id and
an `input` object, and pays the seller through the same path and under the
same automatic limits as a curated lookup. A paid response that is a file (an
audio clip, an image) is saved under `~/.tenjin/downloads` and the result names
the file. Two new hooks watch `AskUserQuestion`: before the question, a fitting
lookup redirects it once; after it, one is offered beside your answers. Hook
requests now carry the session id, used only so one session is not offered the
same service twice. `tenjin install --refresh` (which `tenjin update` runs)
adds the two hook entries.
