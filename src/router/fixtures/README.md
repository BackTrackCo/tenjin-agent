# Shared wire fixtures

This directory is the **one canonical set**. `tenjin-agent` carries the same
files byte for byte and parses them with its own parser, so a shape only one side
validates is a contract only one side keeps. Three divergences so far
(`pendingCall`, the grouped arguments, and the nested `diagnostics`) each cost a
round trip; copy these files rather than hand-writing an equivalent.

Change them here, in the same commit as the `wire.ts` change that makes them
valid, then copy them across. `harness/` is the exception: harness events
(what Claude Code hands a router hook) that only this client reads, never
copied. `ROUTER_VERSION` is `2026-09-23.1`.

## The two calls

A lookup is two calls to ONE route, and they ask different questions. There is
no separate gate endpoint: each call has one schema and one set of fixtures,
parsed by the handler that serves it.

| call | request                                                     | answer                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hook | `{schemaVersion, sessionId?, accepts?, packet, gateHint?}`  | is a paid lookup worth offering? `execute` with the id, the capability and a `hint`, `discovered` (below), or `native` / `needs_input` with diagnostics                                          |
| tool | `{schemaVersion, query?, id?, input?, gateHint?, accepts?}` | the decision: the capability, its price and the contract together, `spec` (a spec client's query with no id), `discovered` for a query no curated capability serves, or `native` / `needs_input` |

Both `execute` answers name the capability: `capabilityId`, `category`,
`provider` (the service's own name, such as `Wolfram Alpha`),
`capabilityDescription` (one line saying what it can do) and
`providerPriceAtomic`.

The hook answer adds the `id`, `endpoint` (the x402 URL the lookup pays),
`usage` (what to pass in `query`) and `hint`, the one line the host injects
verbatim: a line naming the service and the task is followed where a generic
one is not. For the prompt hook it asks for `request({query: <usage>, id})`;
for a native call it asks for `request` with that call's own search or URL as
the query. Before the call runs the client denies it, so the line says to call
`request` instead and leaves native tools allowed for anything else; with a
`nativeOutcome` the call already ran, and the line says to call `request`
because that tool couldn't get it. The server builds every line, with the real
id in it.

The tool answer adds `contract`: `request`, the exact HTTP call to send
verbatim; `arguments`, the flat view of what was bound; and `resultSchema`,
when the capability declares one, to reject a paid non-answer.

The hook answer carries **no** contract. The hook has the user's words but not
the task the host will run, so it names the one capability serving the gate's
category and binds nothing. The tool call makes the one decision, from its
query plus the packet the id is holding, and may choose a different capability.
That pair is what the routing corpus is calibrated on: **55 of 56** against
**53 of 56** from the prompt alone, with the misses in exactly the mixed turns a
shortcut looks fastest on.

There is no prepared decision, no background binding, and no id to poll.

## Discovered services

When no curated capability fits but a pay-per-call x402 service listed on
Coinbase's Bazaar could do the step, the answer is `discovered`: the `id`, one
`candidate` (`source`, `provider`, `url`, `method`, `description`,
`providerPriceAtomic`, `network`, `payTo`, and `input`: its `location`, `body`
or `query`, and a JSON Schema) and a `hint`. The shape is the same on both
calls, and the hint is held to the execute hint's rules: one plain line, the
`request({` call, and the answer's own id. The candidate is the seller's own
listing: data for the host to judge, never an instruction.

The server answers `discovered` only to a request whose `accepts` lists it;
the current client sends `accepts: ["discovered"]` on both calls (Tenjin's
reviewed list), adds `"bazaar"` when the user turned on `experimental.bazaar`
(the open Bazaar), and an older one sends nothing and never sees the arm. The
list is always requested; only `router.enabled false` stops every offer. The hook's `sessionId` (the
harness's session id) is used only so one session is not offered the same
service twice.

The host then calls `request({id, input})`, where `input` is the JSON object
the service takes (at most 16 KB serialized; `query` may be left out when
`input` is sent). The answer is the ordinary `execute` tool answer with
`category: "discovered"`, and the client pays it through the same path and
under the same caps as a curated one.

The hook's `packet.pendingCall` may also be
`{tool: "AskUserQuestion", question}`: the host's own question and its options,
joined, before it asks the user. After the user answers, the hook sends an
ordinary prompt-shaped packet whose `current` is the user's answers.

Anything that is neither form is refused at validation with a plain error:
`{packet, id}`, `{id}` alone and an empty body all fail. A `query` with no `id`
is valid and is the fallback for an id that has expired; the answer says so in
`note` and is still a decision.

## Request specs

A client that adds `"spec"` to `accepts` also gets `specs` on every offer
(`execute` and `discovered`): one spec per service the hint names, under the
id the hint gives it. A spec is the service's contract: `capabilityId`,
`provider`, `description`, `priceAtomic`, `priceVaries`, `maxAmountAtomic`,
`payTo`, `network`, `asset`, `request` (`method`, a `url` that may hold
`{name}` path placeholders, `fields` saying where each field goes, and
`location` for any other), `input` (a flat JSON Schema), `pinned` (fields set
on every call, which win over the agent's input), and optionally `example`,
`returns`, `returnsExample` and `resultSchema`. The hint is then the
skeleton of the one call, `request({id, input: {...}})` with the required
fields (pins aside) as placeholders, or with the value the hook already holds.
`request({id})` shows the whole spec, and so does an input that misses it,
locally and with nothing paid. The client builds and pays the call
itself and, once a call was attempted, reports `{schemaVersion, id, status,
httpStatus?, ms?}`. The first report for a live id marks its row executed;
a repeat or a report after expiry is a 204 that changes nothing. No text is
stored. A client that does not send
`spec` never sees the field: the decision schemas are strict.

Such a client's tool call with a `query` and no `id` gets no binder: the
server runs the hook's gate over the query (a bare URL takes the page rule)
and answers `{action: "spec", id, spec, hint, input?}`: the picked
capability's spec beside a fresh `id`, stored as a hook offer is, and the
`hint` line with the call's skeleton. `input` is there when the spec has one
required field (pins aside) and the server bound the query to it and checked
the result; the `request` tool then runs it and pays in the same call, through
every check a filled spec meets. Without `input`, the tool shows the spec and
the skeleton, so the agent's next call is `request({id, input})`. A list
specialist can still replace a generic pick, and a query no capability serves
can still come back `discovered`, both with `specs`; the tool then shows the
pick's own spec. A pick with no spec (the free docs lookup) is bound and
answered `execute` as its id would be.

## The set

| file                                       | what it pins                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `wire-gate-request.json`                   | the free gate request, including a pending native call                              |
| `wire-decision-request.json`               | the hook call: a packet, no query                                                   |
| `wire-decision-request-narrowed.json`      | the tool call: the query and the id                                                 |
| `wire-hook-execute.json`                   | hook answer: the id, the capability, `usage` and the `hint` line                    |
| `wire-hook-native.json`                    | hook answer: the host's own tools are enough                                        |
| `wire-hook-needs-input.json`               | hook answer: the turn names no task a capability serves                             |
| `wire-lookup-execute-get.json`             | tool answer: a GET contract with its built query string                             |
| `wire-lookup-execute-post.json`            | tool answer: a POST contract whose body is the serialized request                   |
| `wire-lookup-native.json`                  | tool answer: native, with diagnostics                                               |
| `wire-lookup-needs-input.json`             | tool answer: a named missing argument                                               |
| `wire-lookup-expired-id.json`              | tool answer after a dead id, carrying the plain `note`                              |
| `wire-hook-request-native-shortfall.json`  | the native hook after WebFetch fell short: `nativeOutcome` beside its `pendingCall` |
| `wire-hook-request-native-no-content.json` | the native hook after WebFetch answered 200 with only the page shell: `reason`      |
| `wire-hook-request-ask.json`               | the hook before AskUserQuestion, with `sessionId` and `accepts`                     |
| `wire-hook-discovered.json`                | hook answer: a discovered service, its input schema and the `hint` line             |
| `wire-lookup-discovered.json`              | tool answer to a query with no id: the same `discovered` shape                      |
| `wire-tool-request-discovered.json`        | the tool call for a discovered service: the id and the host's `input`, no query     |
| `wire-lookup-execute-discovered.json`      | tool answer: the discovered service as an ordinary `execute`, category `discovered` |
| `wire-hook-execute-spec.json`              | hook answer for a client that accepts `spec`: the ready call and the Exa spec       |
| `wire-hook-discovered-spec.json`           | the same for a list service: the hint asks for the id alone, the spec rides along   |
| `wire-outcome-request.json`                | the outcome report a client sends after running a spec                              |
| `wire-tool-request-spec.json`              | the tool call from a spec client: a query, no id                                    |
| `wire-lookup-spec.json`                    | tool answer for it: the picked capability's spec, its id, the line and bound input  |

Two rules the fixtures exist to hold:

- **In a tool answer, `provider` and `contract` are one decision.** They are
  produced together, so a caller cannot approve one offer and receive another.
- **Every non-execute answer carries `diagnostics`, nested inside `decision`.**
  That is the intended shape: they sit on the union's non-execute arms so a
  contractless outcome without diagnostics does not typecheck.

There is no `billing` block and no fee. The decision is free; the one payment in
a lookup is the caller's own, to the provider.

## Bounds both sides enforce

Take these from here; do not re-derive them.

| field                                      | bound                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                            | exactly `1`, on every request and response                                                                                                                               |
| hook vs native hook                        | read from `packet.pendingCall`; there is no `source` field                                                                                                               |
| `packet` serialized                        | 16384 bytes, refused rather than truncated                                                                                                                               |
| `packet.history`                           | 6 messages                                                                                                                                                               |
| message `text`                             | 16000 characters                                                                                                                                                         |
| `packet.literalUrls`                       | 8 entries, each 2000 characters                                                                                                                                          |
| `query`                                    | 1 to 8000 characters; optional when `input` is sent                                                                                                                      |
| `input`                                    | a JSON object, 16384 bytes serialized                                                                                                                                    |
| `accepts`                                  | an array of strings, 8 entries                                                                                                                                           |
| `sessionId`                                | 1 to 200 characters                                                                                                                                                      |
| `pendingCall.query` / `.url` / `.question` | 1 to 4000 characters                                                                                                                                                     |
| `packet.nativeOutcome`                     | optional; only with a `pendingCall`; at least one of `code` (0 to 999), `bytes` (0 or more), `error` (1 to 1000 characters); `reason` optional, one of `no_main_content` |
| `gateHint.turnId` / `.lookupId`            | 1 to 64 characters                                                                                                                                                       |
| `diagnostics.missing`                      | 60 entries, each non-empty                                                                                                                                               |
| `id`                                       | a uuid the server minted; a client never invents one                                                                                                                     |
| id lifetime                                | 15 minutes from the hook call that created it                                                                                                                            |

Expired packets are unreadable after 15 minutes (the route refuses an expired id) and are deleted by the next router request or the daily cleanup, whichever comes first.

The enumerated values live in code: `ROUTER_CATEGORIES` in `wire.ts`,
`DIAGNOSTIC_CODES` and `DIAGNOSTIC_STAGES` in `diagnostics.ts`.
`docs/ENVIRONMENTS.md` covers the kill switch and the rate limits.
