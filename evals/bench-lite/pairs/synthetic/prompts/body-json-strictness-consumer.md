You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: a size limit on the body a handler is willing to read

h3 will happily buffer whatever a client sends. Apps that want a ceiling currently check
`content-length` by hand, which a chunked request does not have, or they find out when the
process runs out of memory. Several issues have asked for a limit on the read itself.

Add one to `readBody`.

```ts
const body = await readBody(event, { limit: 64 * 1024 });
```

### Interface contract

`readBody(event, options?)` takes a `limit`, a number of **bytes**:

- A body whose raw size is at or below the limit is read and parsed exactly as it is today.
- A body over the limit raises a `413` error with status message `Payload Too Large`. The handler
  does not get the body.
- The size is the size of the raw body in bytes, not its length in characters: a six-character
  string that encodes to ten bytes is ten bytes.
- An empty body is under every limit.
- The limit belongs to the read that asked for it: a reader that names no limit is not affected
  by one another reader asked for, and a body inside the limit is returned as usual.
- Without `limit`, nothing changes: no ceiling, whatever the body's size.
- It composes with `strict`: both may be given in the same options object.

### Scope

- `readBody`, `readRawBody`, `readValidatedBody` and `readFormData` keep the names, signatures and
  exports they have now, beyond this one new option.
- Behaviour the ticket does not name stays exactly as it is today.
