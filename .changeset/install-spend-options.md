---
'tenjin-cli': patch
---

`tenjin install` run by an agent hands over the spend question with three
answers: the default limits, custom limits, or no automatic spending. Each
answer is one install command the agent runs: `tenjin install --yes`,
`tenjin install --max-auto-spend <usd> --session-budget <usd|none>`, or
nothing. The install an answer picks then hands over a second question,
whether to add funds now, with the wallet's fund link and address for later.
On a yes the agent runs `tenjin wallet fund`, which now opens the fund page
under an agent harness too. Each question is in `nextSteps` in `--json`. A
person at a terminal sees no change.
