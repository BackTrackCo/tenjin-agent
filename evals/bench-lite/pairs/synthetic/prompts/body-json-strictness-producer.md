You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: an app-wide hook that sees each request's body

Audit logging, payload sampling and "what did that client actually send us" debugging all want
the same thing: the body of every request, in one place, without touching a single route. Apps do
it today by adding a first layer that reads the body, and the teams that have tried it report
that it is easy to get subtly wrong.

Make it an app option.

```ts
const app = createApp({
  onRequestBody: (event, body) => auditLog.push({ path: event.path, body }),
});
```

### Interface contract

`AppOptions` gains:

```ts
onRequestBody?: (event: H3Event, body: unknown) => void | Promise<void>;
```

- It is called **once per request that carried a body**, before the stack runs, with the body
  parsed the way h3 parses it for that content type: an object for JSON, a string for `text/*`.
- It is not called for a request with no body at all.
- `event` is the event of that request.

**It must not change what the app does.** With the hook set, every route answers exactly as it
answers without it:

- a route that reads the body still gets the same value;
- a route that validates the body still accepts the same bodies and still rejects the same ones,
  with the same status and the same error, byte for byte;
- a route that never reads the body is unaffected.

An app with no `onRequestBody` behaves exactly as it does today.

### Scope

- `createApp`, `createAppEventHandler` and `App` keep their current shapes; this is one new
  optional option.
- `readBody`, `readRawBody`, `readValidatedBody` and `readFormData` keep the names, signatures
  and exports they have now.
- Behaviour the ticket does not name stays exactly as it is today.
