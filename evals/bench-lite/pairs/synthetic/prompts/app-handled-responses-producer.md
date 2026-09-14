You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: how many responses has this app served, and with what status

People ask h3 for the simplest possible traffic number: a counter of responses by status code,
for a `/healthz` payload or a log line at shutdown, without wiring a metrics library. Everyone
who builds it by hand gets numbers that do not match their access log, and it is never obvious
which requests went uncounted.

Put a counter on the app.

```ts
const app = createApp({ collectStats: true });
// ...
app.stats; // { total: 12, byStatus: { "200": 9, "302": 2, "204": 1 } }
```

### Interface contract

`AppOptions` gains `collectStats?: boolean`, default `false`. `App` gains `stats`.

With `collectStats: true`:

- `app.stats` is `{ total: number; byStatus: Record<string, number> }`, and on a fresh app it is
  `{ total: 0, byStatus: {} }`.
- **Every response the app serves adds one**, whatever the handler did to produce it, and `total`
  is the sum of `byStatus`.
- The status counted is the one the client sees: 200 by default, 302 for a redirect, 204 for an
  empty response, and whatever the handler set when it set one. The key is that number as a
  string.
- One request counts once, however many layers it passed through.

Without `collectStats`, `app.stats` is `undefined` and the app behaves exactly as it does today.

A request that produced no response at all (nothing in the stack handled it, so h3 raises its
404) and a request whose handler threw are **out of scope** for this ticket.

### Scope

- `createApp`, `createAppEventHandler` and `App` keep their current shapes, and the app's
  existing hooks keep their current behaviour.
- Behaviour the ticket does not name stays exactly as it is today.
