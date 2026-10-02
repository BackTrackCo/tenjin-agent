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
the card's, and the spend policy. Then it tells the server only how the call
ended. When the hook already holds a card's one input (the search a native call
was about to run, or the page it was about to fetch), the line hands it over
and the call is one step, as before. A query, with or without an id, goes to
the server as before; an id alone with no card kept says so and asks for the
query its line named. A failure now says what was sent.
