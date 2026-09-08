# actorKey: the agent half of the key defaults to root

`actorKey(session, agent)` in `src/actor.mjs` builds `<session>:<agent>`, and the failing case is the one with no agent: the template interpolates `undefined` and the key reads `<session>:undefined`. The rule the test encodes is that a missing agent is the root actor of the session, so the agent half falls back to the literal `root` when it is `undefined` or `null`.

The fix is the fallback in the template:

    return `${session}:${agent ?? 'root'}`;

A present agent is kept as given; only a missing one becomes `root`. Re-run the one file with `pnpm exec vitest run tests/actor.test.mjs`.
