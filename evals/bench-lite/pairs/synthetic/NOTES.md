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

### 1. `cors-default-options` — `handleCors` computes the resolved options and then passes the raw ones

`src/utils/cors/handler.ts:38-44`. `resolveCorsOptions(options)` is assigned to `_options`, and
only `_options.preflight.statusCode` is used; `appendCorsPreflightHeaders` and `appendCorsHeaders`
are handed the caller's raw `options`. Every documented default (`methods: "*"`,
`exposeHeaders: "*"`, `allowHeaders: "*"`) is therefore inert. Separately,
`appendCorsPreflightHeaders` never calls `createMaxAgeHeader`, so `maxAge` is inert even when it
is spelled out. `handleCors` appears nowhere in h3's own tests; `test/cors.test.ts` unit-tests
`resolveCorsOptions` and the header builders in isolation, which is exactly why the disconnect
survives.

- **A** must make `handleCors(event, { origin })` produce a complete preflight. Five of its ten
  assertions fail at base, on the headers the defaults were supposed to supply.
- **Naive B** adds a `cors` option to `createApp` and delegates to `handleCors`, inheriting the
  defect: 3 of 8 fail. The reference resolves the options before handing them over.

### 2. `app-handled-responses` — a handler that writes its own response skips the response hook

`src/app.ts:193-215`. `onBeforeResponse` runs only inside `if (_body !== undefined)`. A handler
that ends the response itself (`sendRedirect`, `send`, `sendNoContent`, `sendStream`,
`sendWebResponse`) returns `undefined`, so control reaches `if (event.handled)` at line 208,
which calls `onAfterResponse` alone. `docs/1.guide/2.app.md:42` says these hooks "are called for
every request". `test/app.test.ts` only ever registers handlers that return a value or throw.

- **A** adds an `onResponse` hook that must fire for both kinds of response: 8 of 9 fail at base.
- **Naive B** adds a `responseHeaders` option and applies it where `onBeforeResponse` is applied,
  the place the docs point at: 5 of 9 fail, and the five are the redirect, the empty response, the
  written body, the 404 and the error. The reference sets the headers before the stack runs,
  because a written response has already been flushed.

### 3. `body-json-strictness` — the JSON branch is chosen by an exact content-type match, and the parse is cached

`src/utils/body.ts:175` compares `contentType === "application/json"`, so
`application/json; charset=utf-8` and `application/vnd.api+json` fall to the `else` at line 183
and are parsed with `strict ?? false`: a truncated body comes back as a raw string instead of
raising 400. `src/utils/body.ts:166-168` returns a cached parse before the options are looked at,
so the strictness of a later read never applies. `test/body.test.ts` tests bare
`application/json`, `text/*` and urlencoded; it never tests a parameterised JSON type and never
reads one body twice.

- **A** must reject malformed JSON for every JSON media type and on every read: 3 of 10 fail at
  base, including the read-twice case.
- **Naive B** adds a `limit` option and checks it where the body is parsed, which is after the
  cached-parse return: the one assertion that reads the body in a layer first fails. The
  reference checks the size before the cache can answer.

### 4. `proxy-forwarded-headers` — the proxy drops `accept` along with the hop-by-hop headers

`src/utils/proxy.ts:25-34`. `ignoredHeaders` holds the genuine hop-by-hop names and also
`accept`, which is not one: a proxied request loses the caller's content negotiation. The JSDoc
says only "without headers known to cause issues when proxying" and never lists them.
`test/proxy.test.ts:73` echoes headers back but asserts on `content-type` and three `x-custom`
keys only.

- **A** must forward `accept` and `accept-language`: 2 of 7 fail at base.
- **Naive B** adds `forwardHeaders` to `sendProxy` and builds the header set with
  `getProxyRequestHeaders`, which is the right function and still drops `accept`: 1 of 6 fails,
  the one that asks the upstream what it was sent. The reference takes `accept` out of the list.

### 5. `sse-message-fields` — the event-stream formatter drops anything outside a narrow type guard

`src/utils/sse/utils.ts:18`: `const data = typeof message.data === "string" ? message.data : ""`.
A structured payload becomes an empty `data:` line, with no error. The same function drops an
`id` of `0` (`if (message.id)`) and any `retry` that is not already an integer `number`.
`test/sse.test.ts` uses string data in every assertion.

- **A** must serialise non-string payloads: 5 of 10 fail at base.
- **Naive B** widens the `id` and `retry` types and converts them to strings, but leaves the
  falsy check and the `typeof` guard in place: 4 of 10 fail, on id `0`, a numeric-string retry
  and a negative retry.

### 6. `session-sliding-expiry` — the session window is anchored to `createdAt`, and the failure to restore is swallowed

`src/utils/session.ts:213` sets the cookie's expiry to `session.createdAt + maxAge * 1000`, and
`createdAt` is written once, when the session is born. `unsealSession` enforces the same absolute
window and throws `Session expired!`; `src/utils/session.ts:141` catches that with
`.catch(() => {})`, after which a brand new session is minted. So an active user is signed out on
schedule, and an app cannot tell an expired or tampered token from a first visit.
`test/session.test.ts` has four cases and none touch `maxAge`, expiry or a bad token.

- **A** adds `rolling` sessions: 3 of 7 fail at base, because re-anchoring the window is the
  whole feature.
- **Naive B** adds an `onRestoreError` callback and decides what happened by looking at the
  session it ended up with rather than at the error that was thrown: 3 of 9 fail, including a
  valid empty session reported as invalid. The reference reads the error in the `catch`.

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

Every diff is small. The work is in finding the line, which is the point: each of these is a
short edit that is unreachable until the agent understands why its first reasonable attempt
changed nothing.

## Leak check

Both prompts of every pair, `grep -nicE`:

| pair                      | terms                                                                   | hits                    |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------- |
| `cors-default-options`    | `discard`, `_options`, `raw option`, `createMaxAgeHeader`, `never call` | 0 / 0                   |
| `app-handled-responses`   | `event.handled`, `_body`, `skip`, `does not fire`, `never runs`         | 0 / 0                   |
| `body-json-strictness`    | `cach`, `symbol`, `memo`, `exact match`, `===`                          | 0 / 1 (benign)          |
| `proxy-forwarded-headers` | `ignoredHeaders`, `ignore list`, `dropp`, `strips`                      | 2 (benign) / 0          |
| `sse-message-fields`      | `typeof`, `coerce`, `silent`, `guard`                                   | 0 / 0                   |
| `session-sliding-expiry`  | `createdAt`, `swallow`, `catch`, `unseal`, `anchor`                     | 1 (benign) / 1 (benign) |

The benign hits: `memo` matches "memory" in a sentence about running out of it; `dropp`/`strips`
match two contract statements about the **response** side of the proxy, which is not the ignore
list; `unseal` matches `unsealSession` in a list of exports whose signatures must not change.
`trap`, `gotcha`, `beware`, `silently` and `bug in` are **0 across all twelve**.

Required separately: `\btests?\b`, `\bspec\b`, `vitest`, `jest` over all twelve prompts returns
**exactly one hit each**, line 3, the working-rules sentence "you may run the repository's
existing test files that are relevant to what you change". No prompt mentions a hidden test, a
grader, or a file to make pass.

## Verification

```bash
bash evals/bench-lite/pairs/synthetic/verify.sh                      # all six
bash evals/bench-lite/pairs/synthetic/verify.sh sse-message-fields   # one
```

Five throwaway worktrees per pair, cut from `repo.git`, installed offline, one oracle file each,
then removed. Thirty cases, about four minutes.

Last run, at `7ec48b5`: **30 of 30 as expected**. Every producer fails at base and passes with its
reference; every consumer fails at base, fails naive, and passes with its reference.

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
