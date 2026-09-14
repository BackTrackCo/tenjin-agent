You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: mount an upstream service on a route

Putting an h3 app in front of another service is four lines of boilerplate every time: a handler
that works out the path, calls the proxy util and returns it. People get the path joining wrong
and end up proxying `/api/api/things`, and the ones who get it right have copied it between
projects.

Give them a handler that does it.

```ts
app.use("/api", proxyEventHandler("https://internal.example.com"));
```

### Interface contract

Export `proxyEventHandler(target, options?)`. It returns an event handler that answers the
request from `target`.

- `target` is a base URL. The path the handler was reached at is appended to it: mounted at
  `/api`, a request for `/api/things` goes to `<target>/things`.
- The caller's request is what reaches the upstream: the same method, the same body, and the
  request headers a proxy may pass on. An upstream that negotiates content, reads a bearer token
  or branches on a custom header behaves exactly as it would if the client had called it
  directly.
- The upstream's response is what the caller gets: its status, its headers and its body.
- The upstream is addressed as itself, so it sees its own host rather than the caller's.
- `options` are the existing `ProxyOptions`, passed straight through, and an explicit header in
  them wins over one taken from the caller's request.
- Handlers on other routes are untouched.

### Scope

- The existing proxy utils keep the names, signatures and exports they have now.
- Nothing changes about the response side: the upstream response's `content-encoding` and
  `content-length` are still dropped, and cookie rewriting is untouched.
- Behaviour the ticket does not name stays exactly as it is today.
