You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: let an app keep a session open on purpose

Apps want to extend a session at a moment of their choosing: the user ticks "keep me signed in",
the editor sends a heartbeat while a draft is open, an admin extends a support session. Today the
only lever is `update`, which is for changing the data, and people are surprised by what it does
and does not do to the session's lifetime.

Give the session manager an explicit way to say "start the clock again".

```ts
const session = await useSession(event, { password, maxAge: 60 * 30 });
await session.renew();
```

### Interface contract

`SessionManager` gains `renew(): Promise<SessionManager>`, alongside `update` and `clear`.

- After `renew()`, the session's `maxAge` window runs from now. With a 60 second `maxAge`, a
  session renewed 50 seconds in is still the same session 50 seconds after that, and can be
  renewed again as often as the app likes.
- It keeps the session: the same `id` and the same data, untouched.
- It issues the session cookie again, with an expiry later than the one the client was holding.
- It returns the manager, so it chains the way `update` does.
- It is harmless on a session that has only just been created, and on a session configured
  without a `maxAge`.
- A session that is never renewed still expires exactly as it does today.

### Scope

- The session utils keep the names, signatures and exports they have now, beyond the new manager method.
- Session cookies stay sealed the way they are sealed today, and the `password`, `name`, `cookie`
  and `sessionHeader` options keep their behaviour.
- Behaviour the ticket does not name stays exactly as it is today.
