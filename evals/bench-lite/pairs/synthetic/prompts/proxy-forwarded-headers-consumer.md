## Feature request: let `sendProxy` pass the caller's headers on

`sendProxy` is the right tool for serving a `GET` from somewhere else: an avatar, a rendered PDF,
a cached page. It sends only the headers the caller of `sendProxy` spells out, so anything that
depends on who is asking, an `Authorization` or a tenant header, has to be copied in by hand at
every call site. People reach for `proxyRequest` instead just to get that, and then also get the
body and method proxying they did not want.

Give `sendProxy` an opt-in for it.

```ts
return sendProxy(event, target, { forwardHeaders: true });
```

### Interface contract

`ProxyOptions` gains `forwardHeaders?: boolean`, default `false`, and `sendProxy` honours it:

- With `forwardHeaders: true`, the request to the target carries the caller's own request
  headers, the ones h3 already considers safe to pass to an upstream. An upstream that
  negotiates content, reads a bearer token or branches on a custom header sees what the caller
  sent.
- The caller's `host` is not passed on; the target's own host is used.
- An entry in `opts.headers` wins over a forwarded header of the same name. Forwarded headers the
  `headers` option does not mention are still sent.
- Without the option, `sendProxy` behaves exactly as it does today: only `opts.headers` is sent,
  and none of the caller's headers.
- Everything else about `sendProxy` is unchanged: the same status, the same response headers, the
  same cookie handling, and it still does not proxy the request body or method.

### Scope

- The existing proxy utils keep the names, signatures and exports they have now, beyond this one
  new option.
- `proxyRequest` keeps behaving as it does today.
- Behaviour the ticket does not name stays exactly as it is today.

---

## Working rules

You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket above.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.
