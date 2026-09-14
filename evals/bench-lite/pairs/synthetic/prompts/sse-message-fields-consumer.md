You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: event streams a dropped client can resume

A browser that loses an event stream reconnects on its own and tells the server the last message
it saw, in the `Last-Event-ID` header. The server can then carry on from there instead of
replaying an hour of progress notifications. Both halves of that are on the app today: it has to
number every message itself, and dig the header out of the request by hand.

Let the stream do it.

```ts
const stream = createEventStream(event, { autoId: true });
if (stream.lastEventId) {
  // resume from there
}
await stream.push({ data: { stage: "build", pct: 40 } });
```

### Interface contract

`EventStreamOptions` gains `autoId?: boolean`, default `false`. `EventStream` gains a
`lastEventId` property.

- With `autoId: true`, every message the stream sends carries an id. They count **from `0`**, in
  the order the messages go out, and the first message of a stream is id `0`.
- A message that names its own id keeps it, and it does not consume a number: pushing three
  messages where the second names `"custom"` gives the ids `0`, `custom`, `1`.
- Messages pushed as a bare string are numbered the same way.
- `stream.lastEventId` is the `Last-Event-ID` the client sent, as a string, or `undefined` on a
  first connection.
- Without `autoId`, a stream numbers nothing, exactly as today.

The payloads these streams carry are progress notifications: the handler pushes an object and the
browser does `JSON.parse(event.data)` on it, so what the client parses must be what the handler
pushed. A payload pushed as a string arrives as it stands.

### Scope

- `createEventStream`, `EventStream.push`, `send`, `close`, `pause`, `resume` and `flush` keep
  the names, signatures and exports they have now, beyond the new option and property.
- Behaviour the ticket does not name stays exactly as it is today.
