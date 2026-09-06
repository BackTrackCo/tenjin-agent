---
'tenjin-cli': patch
---

`tenjin publish --finding <id>` publishes under the child's own title. The
harvest stores the block's `# ` line beside the body, and the publish joins the
two as `# <title>` over the body instead of sending the body alone, which the
shelf refused with `A published post needs a title`. A stored finding with no
title beside it is titled with its own opening words, cut at the first sentence
end or the last word inside 120 characters, and its body is still published
whole; a finding with nothing to derive from is refused as before rather than
published under a title nobody wrote.
