## Feature request: CORS as an app option

Every app that needs CORS writes the same first layer by hand, and people get it wrong: they
forget that the preflight has to short-circuit, or they register it after the router so it never
runs for a matched route. Several issues have asked for CORS to be something you configure on
the app instead.

Add it to `createApp`.

```ts
const app = createApp({
  cors: { origin: ["https://app.example.com"] },
});
```

### Interface contract

`AppOptions` gains `cors?: H3CorsOptions | true`.

- `true` means "allow anything", the same as passing `{}`.
- Left out, the app behaves exactly as it does today: no CORS header ever appears, and an
  `OPTIONS` request reaches the stack like any other request.

With `cors` set, for every request the app handles:

- **A preflight request** is answered by the app itself: the configured preflight status (204
  unless the options say otherwise), and **no layer in the stack runs**, not even one registered
  at `/`.
- **Any other request** is handled normally, and the CORS response headers are on the response.
  They are there whether the handler returned a value or threw: a handler that throws a 418 still
  produces a 418 carrying the CORS headers.

The headers themselves follow the options, and an option the app did not name falls back to h3's
documented CORS default:

| option          | default | header                                                      |
| --------------- | ------- | ----------------------------------------------------------- |
| `origin`        | `*`     | `access-control-allow-origin`, plus `vary: origin` when not `*` |
| `methods`       | `*`     | `access-control-allow-methods`, preflight only               |
| `allowHeaders`  | `*`     | `access-control-allow-headers`, preflight only; echoes the request's `access-control-request-headers` when the default is in force |
| `exposeHeaders` | `*`     | `access-control-expose-headers`                              |
| `credentials`   | `false` | `access-control-allow-credentials: true` only when true      |

An origin the policy does not allow gets no `access-control-allow-origin` header, and its request
is otherwise handled normally.

### Scope

- `createApp`, `createAppEventHandler` and `App` keep their current shapes; this is one new
  optional option.
- No change to `H3CorsOptions`, and none to what the existing CORS utils export.
- Behaviour the ticket does not name stays exactly as it is today.

---

## Working rules

You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket above.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.
