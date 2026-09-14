You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: numeric event ids and a reconnection delay clients can trust

Browsers resume a dropped event stream by sending back the last `id` they saw in
`Last-Event-ID`, and they respect a `retry` line as the reconnection delay. Both are awkward to
use from h3 today.

Event ids are usually a sequence counter, which is a number, and the first one is `0`. Retry
delays usually come out of configuration, which means they arrive as strings.

Make both fields take what people actually have.

### Interface contract

`EventStreamMessage`, and `formatEventStreamMessage` which renders it:

**`id`** is a string or a number.

- A number is rendered as it reads: `{ id: 7 }` gives the line `id: 7`. `0` is a real id and is
  sent: `{ id: 0 }` gives `id: 0`.
- A string is rendered as it stands: `{ id: "42" }` gives `id: 42`.
- No `id` at all, or the empty string, means no `id` line.
- Newlines are stripped from an id, as they are today: `"4\n2"` gives `id: 42`.

**`retry`** is a number of milliseconds, given as a number or as a string of digits.

- `{ retry: 1500 }` and `{ retry: "1500" }` both give the line `retry: 1500`.
- `0` is a valid delay and is sent.
- Anything that is not a whole, non-negative number of milliseconds is left out entirely: `1.5`,
  `-1`, and a string such as `"soon"` produce no `retry` line.

The order of the lines is unchanged: `id`, then `event`, then `retry`, then the `data` lines.
`event` and `data` keep their current behaviour.

### Scope

- `formatEventStreamMessage`, `formatEventStreamMessages`, `createEventStream` and `EventStream`
  keep the names, signatures and exports they have now, beyond `id` and `retry` accepting more
  types.
- Behaviour the ticket does not name stays exactly as it is today.
