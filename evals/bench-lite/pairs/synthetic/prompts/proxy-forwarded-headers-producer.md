You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## A proxied request loses the caller's content negotiation

Reported by a team running an h3 gateway in front of a JSON:API service. Their clients send
`accept: application/vnd.api+json`; the upstream answers with its default representation instead,
and the clients cannot parse it. Calling the upstream directly with the same header works. The
same report mentions `accept-language`: a French client gets English pages through the gateway.

A proxy should pass the caller's negotiation headers on. The headers a proxy must **not** pass on
are the ones that describe the single hop it just terminated.

### Interface contract

`getProxyRequestHeaders(event, opts?)` collects the request's headers and drops only these:

| header              | why                                                               |
| ------------------- | ----------------------------------------------------------------- |
| `connection`        | hop-by-hop                                                        |
| `keep-alive`        | hop-by-hop                                                        |
| `transfer-encoding` | describes this hop's framing                                      |
| `upgrade`           | hop-by-hop                                                        |
| `expect`            | answered by this hop                                              |
| `host`              | names this hop, unless the caller passes `{ host: true }`         |
| `accept-encoding`   | h3 strips `content-encoding` from the upstream response, so asking the upstream to compress would hand the client a body it cannot read |

Everything else is forwarded as it arrived, `accept` and `accept-language` included, alongside the
headers that are forwarded today such as `authorization`, `content-type` and any `x-` header.

`proxyRequest(event, target, opts)` therefore sends the caller's `accept` and `accept-language`
upstream. An `opts.headers` entry still wins over a forwarded header of the same name, as it does
today, and `{ host: true }` still keeps the host.

### Scope

- `getProxyRequestHeaders`, `proxyRequest`, `sendProxy` and `fetchWithEvent` keep the names,
  signatures and exports they have now.
- Nothing changes about the response side: the upstream response's `content-encoding` and
  `content-length` are still dropped, and cookie rewriting is untouched.
- Behaviour the ticket does not name stays exactly as it is today.
