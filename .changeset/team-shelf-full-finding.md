---
'tenjin-cli': minor
---

Team-shelf hits are delivered as the full finding to parents and subagents; public-shelf delivery unchanged.

**The per-session cap is a public-shelf rule now.** At most 5 full-form injections a session still rations what the marketplace may spend of a session's context — a stranger's piece is a lead worth following, and five leads is generous — but a team piece is not a lead. A teammate published it to a deployment only this team can reach, about this repository, so the prompt, research and failure arms attach its body whatever the cap has left. Paid pieces are still never fetched, on either shelf, and the once-per-session dedup is untouched: the same finding is never delivered twice.

**The subagent arm delivers a team body instead of a pointer** (reversing tenjin-agent#233 for the team shelf only). Measured over a week, 56 of 60 child deliveries were pointers and the resource id was followed 4 times, while every full body that landed read as an answer — so the pointer is the form nobody read, and the child dispatched to go and find something out is the context with the most use for the finding. A team hit is fetched with the same byte cap, the same timeout and the same fence a parent's body gets, and it keeps the outcome ask and the delivery marker that make the child's delivery gradable. A public hit is still the capability ladder of tenjin-agent#228, and the arm still makes no request at all for one.

**The fetch has its own deadline inside the fire.** A body fetch is started only while the fetch's own timeout still fits under the SubagentStart watchdog; past that the child gets the pointer and the injected row says `body-budget`, as a shelf that answers the search but not the body says `body-unavailable`. A watchdog kill mid-fetch would cost the child the delivery outright, because the handoff slot has already been taken and deleted by then.
