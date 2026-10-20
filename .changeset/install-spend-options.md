---
'tenjin-cli': patch
---

Spending has two limits with defaults that hold whether or not anyone
answers: a daily budget of $5, the control, and a per-call ceiling of $0.25,
the runaway guard. The wallet balance is the hard stop. The per-call ceiling
can no longer be set below $0.25, the routing deposit: `tenjin install` and
`tenjin config set` refuse a lower amount and say why. The routing deposit
is always $0.25: a lower limit an earlier release left refuses it, and
`tenjin doctor` names the fix. The "spend limits not answered" notices are
gone.

`tenjin install` asks once: "Use the defaults ($5 a day, $0.25 a call) or set
your own limits." Run by an agent, it hands that question over with two
answers, each one install command the agent runs: `tenjin install --yes` or
`tenjin install --max-auto-spend <usd> --session-budget <usd|none>`. There is
no "no automatic spending" answer; `tenjin config set router.enabled false`
turns the router off. The install an answer picks then asks whether to add
$5 now, with the wallet's fund link (preset to $5) and address for later. On
a yes the agent runs `tenjin wallet fund 5`, which now opens the fund page
under an agent harness too. Each question is in `nextSteps` in `--json`, and
only there.
