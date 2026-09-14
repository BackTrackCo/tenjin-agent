# The paid answer endpoint must not charge for a weak match

`POST /api/answer` sells a synthesis sight-unseen: if retrieval returns anything at all, the
caller gets a 402 and pays. The miss-versus-candidates line is currently "did retrieval return
zero rows". That was defensible when we indexed excerpts, but we now index whole bodies and the
keyword leg is OR-joined, so a single incidental word inside a long paid piece is enough to
retrieve it. The route will happily charge for a synthesis over a piece that merely shares a
word with the question, and the caller has no way to know before paying.

Gate what may be quoted on the same strength signal the shortlist already publishes for each
candidate, so an agent reading the shortlist and this route can never disagree about how good a
match is. Only a strong enough semantic match may be quoted; a hit the lexical leg alone found
never qualifies, and when no dense leg ran at all, because no embedder is configured or the
embedding budget is spent or the provider is down, nothing qualifies and the request is a free
miss rather than a guess with a price on it. The refusal has to happen inside retrieval, before
the top-K cut, so a refused row never takes a slot a qualifying row would have filled, and
before any payment machinery is built for the request. A free miss is still recorded as demand.

Update the route description, the agent-facing docs, the OpenAPI text and the MCP tool text so
they say a 402 follows a confident match rather than any match. Nothing about the shortlist
route changes: it still shows weak rows, labelled, and it does not charge. Work within `app/`
and `lib/`, preserve existing interfaces, and run only the focused test files you touch; the
integration lane needs Docker and the answer tests need a deterministic stub embedder driving a
real dense leg rather than a null one.
