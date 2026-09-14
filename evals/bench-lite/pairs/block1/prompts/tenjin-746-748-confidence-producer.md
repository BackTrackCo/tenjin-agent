# Publish a coarse match-strength signal on the decision view

The sidecar push hooks need to know whether the top result is actually a good match before they
put a finding in front of an agent, and before the research arm denies a web search in its
favour. Today the wire carries nothing they can use, so the hook guesses with word overlap
against the question, which is both wrong often and completely opaque when it is wrong. Give
the decision view a coarse, server-derived signal of how strong each candidate's match is.

Derive it from the semantic leg's own similarity, not from the fused ranking score and not from
lexical agreement: the two facts must vary independently, so a candidate that both legs found
and a candidate only the dense leg found can carry the same strength, and whether the lexical
leg agreed is a separate field. When no fusion ran there is nothing to derive it from, so the
field is absent rather than guessed, and a lexical-only hit inside a fused response is the
weakest value there is.

The hard constraint is that no raw number may reach the wire. The existing boundary that keeps
body-derived per-result numbers off responses still holds, and the forbidden-key check that
enforces it must keep rejecting raw scores and similarities everywhere while allowing the new
field on the decision surface only. Browse items never carry it. Update the OpenAPI document,
the agent-facing docs and the fixtures to match. No ranking change, no budget change, no change
to when a query misses. Work within `lib/`, preserve existing interfaces, and run only the
focused test files you touch; the integration lane needs Docker.
