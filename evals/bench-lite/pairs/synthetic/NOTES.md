# synthetic — six trap pairs on h3

Twelve tasks on a real, small, well-tested open-source TypeScript repository. Each pair is built
around a quirk **h3 already has**: the agent doing task A has to work out what the code really
does before its feature can be correct, and task B is different work that silently breaks on the
same quirk. No task is "this test is failing, fix it": every prompt is a feature or behaviour
ticket with an observable contract, and the hidden tests exist only to grade the session
afterwards.

## The repository

|           |                                                                                             |
| --------- | ------------------------------------------------------------------------------------------- |
| upstream  | https://github.com/h3js/h3 (unjs/h3), the HTTP framework                                    |
| pinned at | tag `v1.15.11`, commit `7b9f41fda6038d26a367c2a26a07ed83ee1dbaac`                           |
| licence   | MIT, `LICENSE` kept verbatim in `repo/`                                                     |
| size      | 5,240 lines of TypeScript under `src/`, 5,058 under `test/`                                 |
| suite     | vitest, 24 files, 355 tests, **2.6 s**                                                      |
| install   | `pnpm install --frozen-lockfile --prefer-offline` in **3 s** offline after one warm install |

`repo/` is that tree, plus **two toolchain lines and nothing else**:

```diff
 # pnpm-workspace.yaml
+allowBuilds:
+  '@parcel/watcher': false
+  esbuild: false

 # package.json
-"packageManager": "pnpm@10.28.0"
+"packageManager": "pnpm@11.11.0"
```

pnpm 11 renamed the ignored-builds list and errors out without it, and it would otherwise try to
fetch pnpm 10 on every install. Neither line is a trap and neither touches `src/`.

**No trap is planted. All six are h3's own behaviour at this tag**, which is why each one below
cites the line it lives on. One class of trap this repository cannot supply is an
environment-read-at-import: `grep -rn "process\.env" src/` returns **zero** hits at v1.15.11, so
nothing here is built on one.

`repo.git/` is a bare mirror of `repo/` holding one commit, and it is what the runner cuts
worktrees from. A nested `.git` directory cannot be committed (git records it as a gitlink and
the files never arrive), and carrying h3's real history would add tens of megabytes, so the tree
is squashed into a single commit whose message names the upstream URL and sha. Rebuild it with:

```bash
bash evals/bench-lite/pairs/synthetic/make-fixture-repo.sh   # prints the base sha
```

Fixed identity and date, so the same tree always gives the same sha. Today:
`7ec48b5d0ab80ae1365b2871c4a2a41daee77304`.

## The six traps, all native

Each pair is a pair of **features**. The trap is what the feature runs into on the way, never
what the ticket asks for: no prompt names the function, the file or the behaviour below.

### 1. `cors-default-options` — `handleCors` computes the resolved options and then passes the raw ones

`src/utils/cors/handler.ts:38-44`. `resolveCorsOptions(options)` is assigned to `_options`, and
only `_options.preflight.statusCode` is used; the two header builders are handed the caller's raw
`options`, so every documented default is inert. `handleCors` appears nowhere in h3's own tests.

- **A: CORS as an app option.** `createApp({ cors })` answers preflights and puts the headers on
  every response. The obvious implementation hands the option straight to the one-call helper.
- **B: CORS on one route.** `eventHandler({ cors, handler })`. Naive B does the same thing a
  layer down and inherits the same defect: 3 of 8 fail.
- **A's surprise, in A's words:** "I configured an origin and nothing else, and the preflight came
  back with no `access-control-allow-methods` at all. The helper resolves its documented defaults
  into a local and then passes the caller's raw options to the header builders, so the defaults
  never reach the response."

### 2. `app-handled-responses` — a handler that writes its own response takes the other branch

`src/app.ts:193-215`. The response-side hook runs only inside `if (_body !== undefined)`. A
handler that ends the response itself returns `undefined`, so control reaches `if (event.handled)`
at line 208, which runs a different, shorter path. `docs/1.guide/2.app.md:42` says these hooks are
called "for every request".

- **A: a response counter.** `createApp({ collectStats: true })` and `app.stats`, counting every
  response by status.
- **B: app-wide response headers.** `createApp({ responseHeaders })`. Naive B puts them where the
  response-side hook is applied, which the guide points at: 5 of 9 fail, and the five are the
  redirect, the empty response, the written body, the 404 and the error.
- **A's surprise, in A's words:** "My counter agreed with the access log for JSON routes and
  missed every redirect and 204. The app has two exits: one for a handler that returned a value
  and one for a handler that wrote the response itself, and only the first runs the response-side
  hook."

### 3. `body-json-strictness` — the parsed body is cached, and a later read's options are never consulted

`src/utils/body.ts:166-168` returns the cached parse before the options are looked at, and line
175 picks the JSON branch with an exact `contentType === "application/json"`, so a type with a
`charset` parameter is parsed leniently by default. Nothing in `test/body.test.ts` reads one body
twice.

- **A: an app-wide body hook.** `createApp({ onRequestBody })`, called once per request with the
  parsed body, and explicitly required not to change what any route does.
- **B: a size limit on a read.** `readBody(event, { limit })`, 413 over it. Naive B checks the
  size where the body is parsed, which is after the cached parse is returned: the assertion where
  a layer read the body first fails.
- **A's surprise, in A's words:** "Adding a read in the app changed how a route's validator
  answered a broken body, without touching the route. The first parse is cached on the request
  under a symbol, and the second read gets that value back before its own strictness is even
  looked at."

### 4. `proxy-forwarded-headers` — the proxy drops `accept` along with the hop-by-hop headers

`src/utils/proxy.ts:25-34`. `ignoredHeaders` holds the genuine hop-by-hop names and also
`accept`, which is not one. The JSDoc says only "without headers known to cause issues when
proxying" and never lists them; `test/proxy.test.ts` asserts on `content-type` and three
`x-custom` keys.

- **A: mount an upstream on a route.** `proxyEventHandler(target)`, so `/api/things` is answered
  from `<target>/things` with the caller's method, body and headers.
- **B: let `sendProxy` pass the caller's headers on.** `sendProxy(event, target, { forwardHeaders: true })`.
  Naive B builds the header set with the function that exists for exactly that, and it still
  drops `accept`: 1 of 6 fails.
- **A's surprise, in A's words:** "The upstream kept answering with its default representation.
  The caller's `Accept` never arrives: it is in the proxy's ignore list next to `connection` and
  `keep-alive`, which is not where a content-negotiation header belongs."

### 5. `sse-message-fields` — the event-stream formatter drops anything outside a narrow type guard

`src/utils/sse/utils.ts:18`: `const data = typeof message.data === "string" ? message.data : ""`.
A structured payload becomes an empty `data:` line. The same function drops an `id` of `0`
(`if (message.id)`) and throws on a numeric one (it calls `.replace` on it). `test/sse.test.ts`
uses string data in every assertion.

- **A: stream an iterable.** `sendEventStream(event, source)` pushes each item of an iterable to
  the client, objects and numeric ids included.
- **B: streams a dropped client can resume.** `createEventStream(event, { autoId: true })` numbers
  messages from 0 and exposes `lastEventId`. Naive B numbers them with a counter and pushes
  object payloads: 6 of 7 fail, and the ones with a numeric id hang rather than fail cleanly.
- **A's surprise, in A's words:** "Strings streamed fine and every object arrived as `data:` with
  nothing after it. The formatter keeps the payload only when it is already a string, and it
  treats a falsy id as no id, so the first message of a stream numbered from zero has no id
  either."

### 6. `session-sliding-expiry` — the session window is anchored to a `createdAt` that never moves

`src/utils/session.ts:213` sets the cookie's expiry to `session.createdAt + maxAge * 1000`, and
`createdAt` is written once, when the session is born. `unsealSession` enforces the same absolute
window and throws; line 142 catches that with `.catch(() => {})` and a new session is minted.
`test/session.test.ts` has four cases and none touch `maxAge` or expiry.

- **A: sessions that expire on inactivity.** `useSession(event, { rolling: true })`: activity
  keeps a session open, a quiet gap ends it.
- **B: an explicit renew.** `session.renew()`, for a heartbeat or a "keep me signed in" click.
  Naive B renews by writing the session again, which re-seals it and re-issues the cookie with
  the same expiry it had: 3 of 7 fail.
- **A's surprise, in A's words:** "Writing the session on every visit re-sealed it and changed
  nothing about when it dies. The expiry is computed from the session's own `createdAt`, which is
  set once when the session is created and never again, so the window cannot be moved by touching
  the session."

## Session-size estimates

From building each reference by hand; estimates, not measurements of an agent.

| pair                      | reference A | reference B | naive B | files touched |
| ------------------------- | ----------- | ----------- | ------- | ------------- |
| `cors-default-options`    | 5 lines     | 14          | 11      | 2             |
| `app-handled-responses`   | 18 lines    | 9           | 9       | 1             |
| `body-json-strictness`    | 21 lines    | 18          | 15      | 1             |
| `proxy-forwarded-headers` | 5 lines     | 11          | 7       | 1             |
| `sse-message-fields`      | 15 lines    | 24          | 6       | 2             |
| `session-sliding-expiry`  | 13 lines    | 16          | 13      | 1             |

Every diff is small, and the feature half of it is the easy half. The work is in finding the
line the feature trips over, which is the point: the first reasonable implementation of each of
these ships something that looks finished and is quietly wrong.

## Leak check

The rule these prompts are written to: a ticket describes its own feature's surface and nothing
else. It never names the function the feature trips over, the file that function lives in, or the
behaviour that makes it trip.

Over all twelve prompts, `grep -licF` for the trap-side names finds **none of them**:
`handleCors`, `resolveCorsOptions`, `appendCors*`, `onBeforeResponse`, `event.handled`,
`ParsedBodySymbol`, `ignoredHeaders`, `getProxyRequestHeaders`, `formatEventStreamMessage`,
`unsealSession`, `createdAt`. Nor do `trap`, `gotcha`, `beware`, `silently` or `bug in`.

Per pair, the terms that would describe the trap rather than the feature:

| pair                      | terms                                           | hits                            |
| ------------------------- | ----------------------------------------------- | ------------------------------- |
| `cors-default-options`    | `discard`, `raw option`, `never call`, `inert`  | 0 / 0                           |
| `app-handled-responses`   | `branch`, `skip`, `does not fire`, `never runs` | 0 / 0                           |
| `body-json-strictness`    | `cach`, `symbol`, `memo`, `exact match`         | 0 / 1 (`memo` matches "memory") |
| `proxy-forwarded-headers` | `ignore list`, `hop-by-hop`, `dropp`, `strips`  | 2 (benign) / 0                  |
| `sse-message-fields`      | `typeof`, `coerce`, `guard`, `falsy`            | 0 / 0                           |
| `session-sliding-expiry`  | `swallow`, `catch`, `anchor`, `written once`    | 0 / 0                           |

The two benign proxy hits are contract statements about the **response** side (`content-encoding`
and `content-length` are still dropped), which is not the request-header ignore list the trap
lives in.

Required separately: `\btests?\b`, `\bspec\b`, `vitest`, `jest` over all twelve prompts returns
**exactly one hit each**, line 3, the working-rules sentence "you may run the repository's
existing test files that are relevant to what you change". No prompt mentions a hidden test, a
grader, or a file to make pass, and no ticket asks for a test to be made green.

## Verification

```bash
bash evals/bench-lite/pairs/synthetic/verify.sh                      # all six
bash evals/bench-lite/pairs/synthetic/verify.sh sse-message-fields   # one
```

Five throwaway worktrees per pair, cut from `repo.git`, installed offline, one oracle file each,
then removed. Thirty cases, about four minutes.

Last run, at `7ec48b5`: **30 of 30 as expected**. Every producer fails at base and passes with its
reference; every consumer fails at base, fails naive, and passes with its reference.

A producer's own first cut is worth knowing about too: for `body-json-strictness` the
straightforward implementation of the feature passes 7 of its 8 assertions and fails only the one
the trap governs, which is the shape every pair here is aiming for.

Two things worth knowing about the h3 suite itself:

- `test/sse.test.ts > streams events` is flaky under load in this repository as it stands: it
  passes alone and has failed twice here inside a full-suite run. Oracles run one file each, so
  grading never touches it.
- h3's vitest config turns on `typecheck`, which runs `tsc` over the whole project on every
  `vitest run`. The oracle commands pass `--typecheck.enabled=false` so a session is graded on
  behaviour rather than on the project's type state.

## Running it

```bash
python3 evals/bench-lite/run.py --pairs evals/bench-lite/pairs/synthetic/pairs.json \
    --conditions off,tenjin --repeats 1 --out runs/synthetic-1 --dry-run
```

`pairs.json` points `repo` at `repo.git`, a package-relative path rather than one of the two
named checkouts; `resolve_checkout` in `run.py` takes either.

## Layout

| path                                | what it is                                                             |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `repo/`                             | h3 v1.15.11 plus the two toolchain lines. The readable copy; edit here |
| `repo.git/`                         | bare one-commit mirror of it, what worktrees are cut from              |
| `prompts/`                          | the twelve tickets                                                     |
| `oracles/<pair>/`                   | the hidden tests, copied in after the agent stops                      |
| `reference/<pair>/`                 | reference and naive solutions as patches, never inside `repo/`         |
| `pairs.json`                        | the runner's manifest                                                  |
| `verify.sh`, `make-fixture-repo.sh` | the matrix, and the rebuild                                            |
