---
'tenjin-cli': minor
---

The router's `request` tool now runs an offer from its request spec, in one
call. The client asks for specs (`accepts: ["spec"]`), and the hook that shows
an offer keeps each offered service's spec by its id. The offer line is the
call to make: `request({id, input})` with the required fields as placeholders,
or already filled in when the hook holds them (the search a native call was
about to run, or the page it was about to fetch). `request({id, input})` puts
the pins over the input, checks it against the spec's schema, builds the
request and pays the provider directly through the same `runPay` checks: the
live price against the spec's ceiling, its payee against the spec's, and the
spend policy. An input that misses the spec, or names a field the spec does
not, comes back with every problem and the whole spec (each input with its
description and allowed values, the required fields inside a nested object,
the fields Tenjin pins, one example and what comes back), locally, with
nothing sent or paid; `request({id})` alone shows the same spec, free and
offline. A schema keyword that checks nothing (OpenAPI's `example`, a
vendor's `x-in`) is passed over rather than stopping the check, and a spec
whose input schema cannot be compiled at all is refused with nothing sent or
paid, never paid unchecked. When the call ran or money left, the tool then
tells the server only how the call ended; a refusal before payment (the
spend policy, the spec's terms, the provider's own 4xx) reports nothing. Each
spec id pays once: a retry of a paid id, or a second call racing it, pays
nothing and points at the earlier result or a new offer, while a call that
signed nothing (a refused input) leaves the spec runnable. A call that signed
a payment and then failed without learning the amount (a spend ledger that
could not be written) keeps the id claimed as possibly paid, so a retry signs
nothing and says to check `tenjin payments`. A spec is kept as
long as the server keeps its offer, 15 minutes. A path input of `.` or `..` is
refused before anything is sent, and an input whose varying price lands over
the spec's ceiling is refused before signing, asking for a smaller input. A
query with an id goes to the server as before. A query with no id comes back
as the spec of the service the server picks for it, kept like a hook's: when
the server bound the query to the spec's input, the tool runs and pays it in
the same call; otherwise it shows the spec and the call's skeleton, so the
next call is `request({id, input})`. An id alone with no spec kept says so and
asks for the query its line named. A failure now says what was sent.
