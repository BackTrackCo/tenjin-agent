## Feature request: CORS on one route, not the whole app

Apps that are mostly server-rendered have one or two endpoints a browser calls cross-origin: a
public search JSON endpoint, an upload callback. Turning CORS on for the whole app to serve those
two is more than anyone wants, and writing the layer by hand gets registered in the wrong place
and silently never runs.

The object form of `eventHandler` already carries per-route concerns. Let it carry this one.

```ts
app.use(
  "/widgets",
  eventHandler({
    cors: { origin: ["https://app.example.com"] },
    handler: (event) => listWidgets(event),
  }),
);
```

### Interface contract

`EventHandlerObject` gains `cors?: H3CorsOptions | true`. `true` means "allow anything", the same
as `{}`.

For a handler defined with it:

- A **preflight request** to that route is answered by the handler itself, with the configured
  preflight status (204 unless the options say otherwise), and the route's own `handler` does not
  run.
- **Any other request** runs the handler as usual, and the CORS response headers are on the
  response.
- An origin the policy does not allow gets no `access-control-allow-origin` header, and its
  request is handled normally.
- A route that does not set `cors` behaves exactly as it does today and sets no CORS header.
- The route's own hooks keep working alongside it.

The headers follow the options, and an option the route does not name falls back to h3's
documented CORS default:

| option          | default | header                                                          |
| --------------- | ------- | --------------------------------------------------------------- |
| `origin`        | `*`     | `access-control-allow-origin`, plus `vary: origin` when not `*`  |
| `methods`       | `*`     | `access-control-allow-methods`, preflight only                   |
| `allowHeaders`  | `*`     | `access-control-allow-headers`, preflight only                   |
| `exposeHeaders` | `*`     | `access-control-expose-headers`                                  |
| `credentials`   | `false` | `access-control-allow-credentials: true` only when true          |

### Scope

- `defineEventHandler` / `eventHandler` keep their current signatures for both the function form
  and the object form, beyond this one new optional field.
- No change to `H3CorsOptions`, and none to what the existing CORS utils export.
- Behaviour the ticket does not name stays exactly as it is today.

---

## Working rules

You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket above.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.
