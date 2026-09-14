## Feature request: headers every response of an app should carry

Deployments want a couple of headers on everything an app serves: which edge node answered, which
API version is deployed, a security header or two. Today that means writing a layer and
remembering to register it first, and it still misses whatever does not go through that layer.

Make it an app option.

```ts
const app = createApp({
  responseHeaders: { "x-served-by": "h3-edge-1", "x-api-version": "2026-01" },
});
```

### Interface contract

`AppOptions` gains `responseHeaders?: Record<string, string>`.

Every response the app serves carries them, whatever the handler did to produce it, and
including the 404 and the error responses h3 produces itself.

A handler that sets the same header itself wins: the app's value is a default, not an override.
Headers the handler does not touch are still there.

An app with no `responseHeaders` behaves exactly as it does today and sets no extra header. An
empty object is allowed and adds nothing.

### Scope

- `createApp`, `createAppEventHandler` and `App` keep their current shapes; this is one new
  optional option.
- The existing hooks keep their current behaviour.
- Behaviour the ticket does not name stays exactly as it is today.

---

## Working rules

You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket above.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.
