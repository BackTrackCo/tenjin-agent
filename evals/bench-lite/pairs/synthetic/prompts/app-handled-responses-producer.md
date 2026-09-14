You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: one app hook that sees the final status of every response

People wire up request logging and metrics on `createApp` and then find their numbers do not add
up: some responses are counted, some are not, and the ones that go missing are the interesting
ones (redirects, empty responses, anything streamed). The two existing response hooks are shaped
around the value a handler returned, which is not a thing every response has.

Add a hook that is about the response rather than the returned value.

### Interface contract

`AppOptions` gains:

```ts
onResponse?: (
  event: H3Event,
  response: { statusCode: number; body?: unknown; handled: boolean },
) => void | Promise<void>;
```

It is called **once per request that produced a response**, whichever way the response came
about:

- the handler returned a value: `body` is that value, `handled` is `false`;
- the handler produced the response itself, through `send`, `sendNoContent`, `sendRedirect`,
  `sendStream`, `sendWebResponse` or anything else that writes to the response directly: `body`
  is `undefined` and `handled` is `true`.

In both cases `statusCode` is the status the client will see: 200 by default, 302 for a redirect,
204 for an empty response, and whatever the handler set on the response when it set one.

Other rules:

- Once per request, not once per layer: a stack where the first handler returns `undefined` and a
  later one answers calls the hook exactly once.
- The event passed to it is the event of that request.
- Where `onAfterResponse` is also configured, `onResponse` runs first.
- It is optional, and an app without it behaves exactly as it does today.
- A request that produces no response at all (nothing in the stack handled it, so h3 raises its
  404) and a request whose handler threw are **out of scope** for this ticket; the existing
  `onError` and `onAfterResponse` cover those.

### Scope

- `createApp`, `createAppEventHandler`, `App` and the existing `onRequest`, `onBeforeResponse`
  and `onAfterResponse` hooks keep their current shapes and their current behaviour.
- Behaviour the ticket does not name stays exactly as it is today.
