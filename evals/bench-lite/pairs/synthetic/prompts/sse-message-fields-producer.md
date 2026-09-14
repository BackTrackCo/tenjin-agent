## Feature request: stream an iterable to the client as server-sent events

Every app that streams progress writes the same handler: make an event stream, loop over
something that yields, push each item, remember to close at the end, remember to return the
stream. It is six lines of ceremony around one loop, and the docs example for the SSE utils even
imports a `sendEventStream` that does not exist yet.

Add it.

```ts
app.use(
  eventHandler((event) => sendEventStream(event, watchBuildProgress())),
);
```

### Interface contract

Export `sendEventStream(event, source, options?)` from the SSE utils, alongside
`createEventStream`.

- `source` is an iterable or an async iterable. Each item it yields becomes **one** message to
  the client, in order.
- An item is either the message's payload, or an object that names its own fields:
  `{ id?, event?, data }`.
- The payload can be anything a JSON API deals in. A string arrives at the client as it stands;
  an object, an array, a number or a boolean arrives as JSON, so `JSON.parse(event.data)` in the
  browser gives back what the handler yielded.
- An item may carry an `id`, a string or a number, which the client sees on that message. `0` is
  a real id: it is the first message of a stream that numbers from zero.
- An item may carry an `event` name, which the client sees on that message.
- When the source is exhausted the stream closes and the response ends. An empty source is a
  valid, empty stream.
- The response is a normal h3 event stream: status 200, `content-type: text/event-stream`, and
  the handler returns what `sendEventStream` returns.
- `options` are the `EventStreamOptions` `createEventStream` already takes.

### Scope

- `createEventStream`, `EventStream` and its methods keep the names, signatures and exports they
  have now.
- Behaviour the ticket does not name stays exactly as it is today.

---

## Working rules

You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket above.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.
