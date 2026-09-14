You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Truncated JSON reaches handlers as a string instead of being rejected

A user reported an API that stores rubbish when a client's upload is cut short. They post JSON,
their proxy truncates the body, and instead of the 400 they expect, the handler receives the
truncated text as a plain string and writes it to the database. They only see it in the data.

They send `content-type: application/json; charset=utf-8`, which is what their HTTP client sets
by default. With a bare `content-type: application/json` the same request is rejected properly.
The same hole is there for the `+json` media types (`application/vnd.api+json`,
`application/problem+json`), which are JSON as far as any client is concerned.

Make body parsing treat a JSON media type as JSON whatever else the header carries.

### Interface contract

`readBody(event, options?)`:

- A request whose media type is JSON is parsed strictly by default: a body that is not valid JSON
  raises the existing 400 with message `Invalid JSON body`.
- "media type is JSON" means the part of `content-type` before any `;` parameter, compared
  case-insensitively, is `application/json` or ends with `+json`. A `charset` or any other
  parameter makes no difference.
- A valid body of such a type parses to its value, as it does today: `{"a":1}` becomes the object
  `{ a: 1 }`.
- `readBody(event, { strict: false })` still opts out: a malformed body of a JSON media type comes
  back as the raw string instead of raising.
- The strict reading applies **however many times the body is read**: if one layer reads the body
  leniently and a later handler reads it with the default options, the later read raises the 400.
  Two reads of a valid body both return the same parsed value.
- Everything else keeps today's behaviour: `text/*` comes back as a string and is never parsed,
  `application/x-www-form-urlencoded` is parsed as a form, and a request with some other or
  missing content type is parsed leniently.

### Scope

- `readBody`, `readRawBody`, `readValidatedBody` and `readFormData` keep the names, signatures and
  exports they have now, and `readValidatedBody` keeps validating what `readBody` returns.
- Behaviour the ticket does not name stays exactly as it is today.
