---
'tenjin-cli': minor
---

The router's `request` tool now runs an offer from its tool card. The client
asks for cards (`accepts: ["card"]`), and the hook that shows an offer keeps
each offered service's card by its id. `request({id})` shows the card, free
and offline: what the service does and costs, each input with its description
and allowed values, the fields Tenjin pins, one example and what comes back.
`request({id, input})` puts the pins over the input, checks it against the
card's schema (every problem at once, with the allowed values and the
example), builds the request and pays the provider directly through the same
`runPay` checks: the live price against the card's ceiling, its payee against
the card's, and the spend policy. When the call ran or money left, it then
tells the server only how the call ended; a refusal before payment (the spend
policy, the card's terms, the provider's own 4xx) reports nothing. Each card id pays once: a retry of a paid id, or a second call racing
it, pays nothing and points at the earlier result or a new offer, while a call
that paid nothing (a refused input) leaves the card runnable. A card is kept
as long as the server keeps its offer, 15 minutes. A path input of `.` or `..`
is refused before anything is sent, and an input whose varying price lands
over the card's ceiling is refused before signing, asking for a smaller input. When the hook already holds a card's one input (the search a native call
was about to run, or the page it was about to fetch), the line hands it over
and the call is one step, as before. A query with an id goes to the server as
before. A query with no id comes back as the card of the service the server
picks for it, kept like a hook's, so the next call is `request({id, input})`;
a server that predates cards still answers it with a decision. An id alone
with no card kept says so and asks for the query its line named. A failure now
says what was sent.
