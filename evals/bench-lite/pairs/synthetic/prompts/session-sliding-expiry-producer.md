You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: sessions that expire on inactivity, not on the clock

`maxAge` today is the time from when a session was created. A user who signs in, then works
steadily for the whole window, is signed out mid-task; the app cannot distinguish them from
someone who closed the laptop an hour ago. Every session library has the other behaviour as an
option, usually called a rolling or sliding session: the window is measured from the last visit,
so activity keeps it open and only inactivity ends it.

Add it as an option.

```ts
const session = await useSession(event, {
  password,
  maxAge: 60 * 30,
  rolling: true,
});
```

### Interface contract

`SessionConfig` gains `rolling?: boolean`, default `false`.

With `rolling: true` and a `maxAge`:

- A session that is used again inside the window stays the same session: same `id`, same data. It
  stays the same however long the user keeps coming back, including well past `maxAge` after it
  was first created, as long as no single gap between visits is longer than `maxAge`.
- The session cookie's expiry moves forward on each visit, to that visit plus `maxAge`.
- A gap longer than `maxAge` ends it: the next request gets a brand new session, with a new id
  and empty data, exactly as an unknown visitor does today.

Without `rolling` nothing changes: the window runs from when the session was created, and a
session older than `maxAge` is gone even if the user has been active throughout.

`rolling` without a `maxAge` changes nothing, since there is no window to roll.

### Scope

- The session utils keep the names, signatures and exports they have now, beyond this one new config field.
- Session cookies stay sealed the way they are sealed today, and the `password`, `name`, `cookie`
  and `sessionHeader` options keep their behaviour.
- Behaviour the ticket does not name stays exactly as it is today.
