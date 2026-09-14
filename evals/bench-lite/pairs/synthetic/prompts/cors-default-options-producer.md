You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Browsers are blocking cross-origin calls that our CORS options say are allowed

Reported by two users within a week, with the same shape both times. They call `handleCors` with
an origin policy and nothing else:

```ts
app.use(
  eventHandler((event) => {
    if (handleCors(event, { origin: ["https://app.example.com"] })) {
      return;
    }
    return handle(event);
  }),
);
```

`GET` and `POST` work. A `DELETE` or a `PUT` from the browser fails at the preflight, and a
response header the app sets is not readable from JavaScript. Setting `maxAge` to cut down the
preflight traffic also does nothing. The server log shows a clean 204 for each preflight.

`handleCors` is meant to be the one-call helper: give it an origin policy, get correct CORS.
Every option it documents should take effect, and the ones the caller leaves out should fall back
to the documented defaults.

### What must be true afterwards

For `handleCors(event, options)`:

- **On a preflight request** (the existing `isPreflightRequest` definition), it answers with
  `preflight.statusCode` (default 204), the handler chain does not run, and the response carries:
  - `access-control-allow-origin` per the origin policy, with `vary: origin` where the policy is
    anything other than `*`;
  - `access-control-allow-methods`, from `methods`, defaulting to `*`;
  - `access-control-allow-headers`, from `allowHeaders`; where the caller named none, it echoes
    the request's `access-control-request-headers`;
  - `access-control-expose-headers`, from `exposeHeaders`, defaulting to `*`;
  - `access-control-allow-credentials: true` only where `credentials` is true, which it is not by
    default;
  - `access-control-max-age`, where `maxAge` is set. It is not set by default, and it never
    belongs on a non-preflight response.
- **On any other request with an `Origin`**, it returns `false`, the handler runs, and the
  response carries the origin, credentials and expose-headers headers, and none of the
  preflight-only ones.
- An origin the policy does not allow gets no `access-control-allow-origin` header at all, and
  the request is otherwise handled normally.
- `handleCors(event, {})` is "allow anything": origin `*`, methods `*`, expose-headers `*`.

Defaults are the ones `resolveCorsOptions` already documents: `origin: "*"`, `methods: "*"`,
`allowHeaders: "*"`, `exposeHeaders: "*"`, `credentials: false`, `maxAge: false`,
`preflight.statusCode: 204`.

### Scope

- `handleCors`, `isPreflightRequest`, `appendCorsHeaders`, `appendCorsPreflightHeaders` and
  `resolveCorsOptions` keep the names, signatures and exports they have now. The two
  `appendCors*` helpers are the low-level API and keep taking the options they are handed, as
  they do today.
- No change to the `H3CorsOptions` type.
- Behaviour the ticket does not name stays exactly as it is today.
