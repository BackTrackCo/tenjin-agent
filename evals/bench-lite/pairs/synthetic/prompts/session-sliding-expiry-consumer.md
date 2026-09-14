You are working in the h3 repository (unjs/h3, the HTTP framework). Implement the ticket below.

Working rules for this session: you may run the repository's existing test files that are
relevant to what you change, but never the whole suite with no file argument, and never leave a
server or watcher running. Do not spawn subagents.

---

## Feature request: tell the app when a session token could not be restored

An app cannot currently tell these three visitors apart: someone arriving for the first time,
someone whose session has been sitting too long, and someone presenting a token that was
tampered with or sealed with a password we have since rotated. All three get a brand new empty
session and no signal.

They want different treatment. The first sees the marketing page; the second sees "your session
timed out, sign in again"; the third is worth a log line and, for one user of ours, an alert.

Give the app a callback.

```ts
const session = await useSession(event, {
  password,
  maxAge: 60 * 30,
  onRestoreError: (event, { reason, error }) => {
    logger.warn({ reason, err: error }, "session not restored");
  },
});
```

### Interface contract

`SessionConfig` gains:

```ts
onRestoreError?: (
  event: H3Event,
  details: { reason: "expired" | "invalid"; error: Error },
) => void;
```

It is called **once**, and only when a session token was presented and could not be restored:

- `reason: "expired"` when the token was well formed and readable but is past the window `maxAge`
  allows.
- `reason: "invalid"` for anything else that stops a presented token being restored: it was
  tampered with, truncated, or sealed with a different password.
- `error` is the `Error` that describes the failure.
- `event` is the event of the request the token arrived on.

It is **not** called when:

- no session token was presented at all;
- the token restored successfully, **including when the session it restores holds no data at
  all**, which is what an untouched new session looks like;
- the token is inside its window.

After the callback, the request continues exactly as it does today: it gets a brand new session
with a new id and empty data, and a new token. An app that does not set the callback behaves
exactly as it does today.

### Scope

- `useSession`, `getSession`, `updateSession`, `sealSession`, `unsealSession` and `clearSession`
  keep the names, signatures and exports they have now, beyond this one new config field.
- Behaviour the ticket does not name stays exactly as it is today.
