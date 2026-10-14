---
'tenjin-cli': patch
---

The router client now asks for Tenjin's one catalog (`accepts: ["catalog", "spec"]`,
plus `bazaar` while `experimental.bazaar` is on). Every catalog offer, the former
Tenjin list services included, comes back as one kind of offer: a line naming up
to three services of one task, each with its spec, and a compare group's choices
on any offer. A paid result's files are saved whenever the service's spec says its
output is media, whatever its id. And one rule now covers every offer whose call
would stop on `needs_approval` or an empty wallet: it is shown with a sentence
saying so where the agent can ask the user, and withheld where it cannot (a
subagent, a delegated task, a question to the user). Needs the server side of
tenjin#969 deployed first: against an older router this build gets no Tenjin list
offers and no choices.
