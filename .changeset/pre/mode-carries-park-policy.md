---
'tenjin-cli': patch
---

Make `publish.mode` govern what happens to a finished draft, and make every
publish decision ephemeral.

Doubt is two judgments with different answers. Privacy and rights doubt — private
context, third-party data, rights, competitor reconstruction — means do not
publish; the skills no longer tell the agent to keep a copy anywhere. Quality
doubt is the agent's own uncertainty about an unverified claim or a missing
polish pass, and the resolved mode decides it: `review` was asking anyway, `auto`
asks the user through the harness's own question or permission UI when it has one
so the answer is a click rather than a prose reply, and `full-auto` hedges the
claim honestly in the piece — named as unverified, with a date — and publishes.

**A decision is ephemeral.** Nothing is saved in order to re-ask: a "no" is final,
closes the loop with an outcome report, and is never raised again. The skills
previously taught parking a draft in the candidate pen as the answer to almost
every stop, which quietly turned "not now" into a backlog nobody returns to and
made a withheld piece indistinguishable from work that never happened. Where a
publish genuinely cannot proceed — a hard block, a permission denial, no wallet —
the instruction is now to say so and leave the draft file where it is. The
candidate verbs still exist in the CLI this release; the skills simply stop
teaching them as a step.

The `tenjin-publish` skill also gains a third trigger, in its description and its
body: finishing substantial research that is public, durable, and reusable — a
multi-source synthesis, a tested comparison, a runbook — is worth offering to
publish once, routed by the same mode, even when no search preceded it. Drive-by
"we should write this up sometime" musing stays excluded, as it already was.

The mode is resolved per run, so `tenjin config set publish.mode <mode>` changes
this behavior on the next command with nothing to re-install and no session to
restart.
