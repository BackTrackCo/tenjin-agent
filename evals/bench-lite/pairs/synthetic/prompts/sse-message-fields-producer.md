You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Server-sent events arrive empty when the payload is not a string

Two reports of the same thing. Someone streams progress from a long job:

```ts
eventStream.push({ event: "progress", data: { pct: 40, stage: "build" } });
```

The browser's `onmessage` fires, `event.data` is the empty string, and there is nothing in the
server log. Switching to `JSON.stringify` by hand fixes it, which is how both reporters worked it
out, eventually.

An event stream is the natural way to push structured updates, and every client parses `data`
with `JSON.parse`. Serialise the payload instead of losing it.

### Interface contract

`EventStreamMessage.data` takes any JSON-serialisable value, and
`formatEventStreamMessage(message)` turns it into the `data:` lines of one SSE message:

- A **string** is sent as it stands, not quoted and not re-encoded:
  `{ data: "hello world" }` gives `data: hello world\n\n`, and a string that already holds JSON
  (`'{"already":"json"}'`) is sent unchanged.
- **Anything else** is serialised with JSON: an object gives `data: {"pct":40}`, an array gives
  `data: [1,2,3]`, and a number, a boolean or `null` give `data: 40`, `data: false`,
  `data: null`.
- `undefined` keeps today's behaviour and produces one empty data line, `data: \n\n`.
- A payload whose serialised form contains newlines is still split across one `data:` line per
  line, as a multi-line string is today.
- The `event`, `id` and `retry` lines keep their current shape and their current order relative
  to the data lines.
- `formatEventStreamMessages(messages)` serialises each message the same way.

`EventStream.push` accepts the same payloads, since it hands the message to the formatter.

### Scope

- `formatEventStreamMessage`, `formatEventStreamMessages`, `createEventStream` and `EventStream`
  keep the names, signatures and exports they have now, beyond `data` accepting more types.
- Behaviour the ticket does not name stays exactly as it is today.
