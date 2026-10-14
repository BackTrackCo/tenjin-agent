# Shared wire fixtures

This directory is the **one canonical set**. `tenjin-agent` carries the same
files byte for byte and parses them with its own parser, so a shape only one side
validates is a contract only one side keeps. Three divergences so far
(`pendingCall`, the grouped arguments, and the nested `diagnostics`) each cost a
round trip; copy these files rather than hand-writing an equivalent.

Change them here, in the same commit as the `wire.ts` change that makes them
valid, then copy them across. `harness/` is the exception: harness events
(what Claude Code hands a router hook) that only this client reads, never
copied. `ROUTER_VERSION` is `2026-10-13.1`.

## The calls

A lookup is calls to ONE route. Every request lists `spec` in `accepts`: each
capability needs a client that runs its spec, so a request without it (what
tenjin-cli 0.1.0-alpha.21 and older send) is answered `native` with the
`client_outdated` diagnostic, on every form.

| call | request                                                   | answer                                                                                                             |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| hook | `{schemaVersion, sessionId?, accepts, packet, gateHint?}` | `execute` with the id, the capability, its `specs` and a `hint`, `discovered` (below), or `native` / `needs_input` |
| tool | `{schemaVersion, query, id?, accepts}`                    | `spec` for a query with no id, `execute` for the free docs offer's id, `discovered`, or `native` / `needs_input`   |

Both `execute` answers name the service: `capabilityId` (its catalog id),
`category` (the catalog task it does, at most 64 characters), `provider` (the
service's own name, such as `Wolfram Alpha`), `label` (its display name, 1 to
32 characters), `capabilityDescription` (one line saying what it can do) and
`providerPriceAtomic`.

This client sends `accepts: ["catalog", "spec"]`, plus `"bazaar"` while the
user has `experimental.bazaar` on. With `catalog`, every catalog offer is an
`execute`: one service, or up to three of one task, each under its own id
with its spec in `specs` and the top-level fields the first's, plus `choices`
when the lead service belongs to a compare group (Compare choices, below).
Each price in a line reads `about $X per call`, the one form the client's
over-cap note reads.

The hook answer adds the `id`, `endpoint` (the x402 URL the lookup pays),
`usage` (what to pass in `query`), `specs` and `hint`, the one line the host
injects verbatim: the call with its spec's input sketched in (below). Before a
native call runs the client denies it, so the line says to call `request`
instead and leaves native tools allowed for anything else; with a
`nativeOutcome` the call already ran, and the line says to call `request`
because that tool couldn't get it. The server builds every line, with the real
id in it.

The hook answer carries no contract: the client builds every paid call from a
spec. The free docs lookup has no spec; its line asks for
`request({query: <usage>, id})`, and that tool call is answered `execute` with
`contract`, the request built from the query (`request`, `arguments`). There
is no prepared decision, no binding on the server, and no id to poll.

## Discovered services

When no catalog task fits, a request that sends `bazaar` may be answered with a
pay-per-call service from Coinbase's open x402 Bazaar: `discovered`, the `id`, one
`candidate` (`source`, `provider`, `url`, `method`, `description`,
`providerPriceAtomic`, `network`, `payTo`, and `input`: its `location`, `body`
or `query`, and a JSON Schema) and a `hint`. The shape is the same on both
calls, and the hint is held to the execute hint's rules: one plain line, the
`request({` call, and the answer's own id. The candidate is the seller's own
listing: data for the host to judge, never an instruction.

A released client that sends `discovered` but not `catalog` is still sent a
former Tenjin list service in this shape, under its old `discovered:tenjin:`
id (`wire-hook-discovered-spec.json`); this client never is. The hook's
`sessionId` (the harness's session id) is read only so the catalog's menu
sentence goes out once per session.

Each offered service carries its spec in `specs`. The host fills it and calls
`request({id, input})`, which this client builds and pays through the same
path and under the same caps as a catalog one.

## Compare choices

An offer whose lead service belongs to a compare group carries `choices`,
`{group, default, input, options, all}`, on `execute` (a `catalog` client) or
`discovered` (a released client that sent `choices`). Each option is
`{key, label, strength, id}` under its own id with its spec in `specs`; the
`default` option's id is the answer's own. The client keeps the set by that
id, and `request({id, choice, input})` runs the chosen option, or every one
with `all`, each as its own payment.

The hook's `packet.pendingCall` may also be
`{tool: "AskUserQuestion", question}`: the host's own question and its options,
joined, before it asks the user. After the user answers, the hook sends an
ordinary prompt-shaped packet whose `current` is the user's answers.

Anything that is neither form is refused at validation with a plain error:
`{packet, id}`, `{id}` alone and an empty body all fail. A `query` with an id
that has expired is answered as a query with no id; the answer says so in
`note` and is still a decision. An input for an id whose spec this client no
longer keeps is answered here, `needs_input` naming `request({query})`, with no
server call.

## Request specs

Every offer (`execute` and `discovered`) carries `specs`: one spec per service the hint names, under the
id the hint gives it. A spec is the service's contract: `capabilityId`,
`provider`, `description`, `priceAtomic`, `priceVaries`, `maxAmountAtomic`,
`payTo`, `network`, `asset`, `request` (`method`, a `url` that may hold
`{name}` path placeholders, `fields` saying where each field goes, and
`location` for any other), `input` (a flat JSON Schema), `pinned` (fields set
on every call, which win over the agent's input), and optionally `label`,
`holds` (the input field that takes a pending search's query or fetch's URL),
`output` (`json`, `text` or `media`: a `media` result's files are saved
locally; a spec without it is media when its id starts `discovered:`),
`example`, `returns`, `returnsExample`, `resultSchema` and `outputSchema`. `outputSchema`
names the fields the result promises (`type`, `properties`, `items`,
`required`): the client checks `resultSchema` on the whole body, then hands the
agent only the properties `outputSchema` declares, through objects and array
items, and saves the whole body to a file it names in `fullResultPath`
(`wire-lookup-spec-skeleton.json` carries Apollo's). The hint is then the
skeleton of the one call, `request({id, input: {...}})` with the required
fields (pins aside) as placeholders, or with a value already known: the one
the hook holds, the field's schema `default`, or a number's or boolean's value
from the `example`.
`request({id})` shows the whole spec, and so does an input that misses it,
locally and with nothing paid. The client builds and pays the call
itself and reports how every call for an id ended, `{schemaVersion, id,
status, reason?, httpStatus?, ms?}`, with the provider's HTTP status whenever
it is known. A call stopped before anything was signed is `unpaid` with a
`reason` (`input`, `terms`, `provider`, `unreachable` or `wallet`), which never
marks the row. The first report of a call that ran, for a live id, marks its
row executed; any other is a 204 that changes nothing. No text is stored.

A tool call with a `query` and no `id` runs the hook's gate over the query (a bare URL takes the page rule)
and answers `{action: "spec", id, spec, hint}`: the picked
capability's spec beside a fresh `id`, stored as a hook offer is, and the
`hint` line with the call's skeleton. The answer never carries an `input`, so
nothing runs or is paid on it: the tool shows the spec and the skeleton, and
the agent's next call is `request({id, input})` with the fields filled. A
pick from a compare group adds `choices` and each option's spec in `specs`,
with the choice's line as `hint`, kept by the answer's id as an offer's set
is (Compare choices, above). A query no catalog task serves can still come
back `discovered` with `specs`; the tool
then shows the pick's own spec. A pick with no spec (the free docs lookup) is bound and
answered `execute` as its id would be.

## The set

| file                                       | what it pins                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `wire-gate-request.json`                   | the free gate request, including a pending native call                                    |
| `wire-decision-request.json`               | the hook call: a packet, no query                                                         |
| `wire-decision-request-narrowed.json`      | the tool call: the query and the id                                                       |
| `wire-hook-execute.json`                   | hook answer: the id, the capability, `usage` and the `hint` line                          |
| `wire-hook-native.json`                    | hook answer: the host's own tools are enough                                              |
| `wire-hook-needs-input.json`               | hook answer: the turn names no task a capability serves                                   |
| `wire-lookup-native.json`                  | tool answer: native, with diagnostics                                                     |
| `wire-lookup-needs-input.json`             | tool answer: a named missing argument                                                     |
| `wire-lookup-expired-id.json`              | tool answer after a dead id, carrying the plain `note`: the free docs lookup's `execute`  |
| `wire-hook-request-native-shortfall.json`  | the native hook after WebFetch fell short: `nativeOutcome` beside its `pendingCall`       |
| `wire-hook-request-native-no-content.json` | the native hook after WebFetch answered 200 with only the page shell: `reason`            |
| `wire-hook-request-ask.json`               | the hook before AskUserQuestion, with `sessionId` and `accepts`                           |
| `wire-hook-discovered.json`                | hook answer: a discovered service, its input schema and the `hint` line                   |
| `wire-lookup-discovered.json`              | tool answer to a query with no id: the same `discovered` shape                            |
| `wire-hook-execute-spec.json`              | hook answer for a client that accepts `spec`: the call with the held search, the Exa spec |
| `wire-hook-discovered-spec.json`           | a former list service translated for a released client, under its old id                  |
| `wire-hook-discovered-choices.json`        | a compare group's `choices` on a released client's `discovered` answer                    |
| `wire-lookup-discovered-choices.json`      | the tool fallback's `choices`, with fresh ids                                             |
| `wire-hook-request-choices.json`           | the hook from a released client that sent `choices`                                       |
| `wire-hook-request-catalog.json`           | the hook from this client: `catalog`, `spec` and `bazaar`                                 |
| `wire-hook-execute-catalog.json`           | a media service as `execute`: its label, and a spec with `holds` and `output`             |
| `wire-hook-execute-catalog-multi.json`     | one `execute` naming three services of one task, each under its own id and spec           |
| `wire-hook-execute-catalog-choices.json`   | a compare group's `choices` on an `execute`                                               |
| `wire-tool-request-catalog.json`           | the tool call from this client: a query, no id                                            |
| `wire-lookup-spec-catalog.json`            | tool answer for it: the lead service's spec, labelled, with `holds` and `output`          |
| `wire-lookup-spec-catalog-choices.json`    | tool answer for an image query: the lead's spec, and `choices` with each option's spec    |
| `wire-outcome-request.json`                | the outcome report a client sends after running a spec                                    |
| `wire-outcome-unpaid.json`                 | a call stopped before anything was signed, with its `reason`                              |
| `wire-tool-request-spec.json`              | the tool call from a spec client: a query, no id                                          |
| `wire-lookup-spec.json`                    | tool answer for it: Wolfram's spec under a fresh id and the skeleton line, no `input`     |
| `wire-lookup-spec-skeleton.json`           | tool answer for a spec with more to fill (Apollo): the skeleton line, no `input`          |

Two rules the fixtures exist to hold:

- **In an offer, the line and its `specs` name the same ids.** A caller cannot
  approve one service and run another.
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
| `query`                                    | 1 to 8000 characters                                                                                                                                                     |
| `input`                                    | a JSON object, 16384 bytes serialized; built into a spec's request here, never sent                                                                                      |
| `accepts`                                  | an array of strings, 8 entries                                                                                                                                           |
| `sessionId`                                | 1 to 200 characters                                                                                                                                                      |
| `pendingCall.query` / `.url` / `.question` | 1 to 4000 characters                                                                                                                                                     |
| `packet.nativeOutcome`                     | optional; only with a `pendingCall`; at least one of `code` (0 to 999), `bytes` (0 or more), `error` (1 to 1000 characters); `reason` optional, one of `no_main_content` |
| `gateHint.turnId` / `.lookupId`            | 1 to 64 characters                                                                                                                                                       |
| `diagnostics.missing`                      | 60 entries, each non-empty                                                                                                                                               |
| `id`                                       | a uuid the server minted; a client never invents one                                                                                                                     |
| id lifetime                                | 15 minutes from the hook call that created it                                                                                                                            |

Expired packets are unreadable after 15 minutes (the route refuses an expired id) and are deleted by the next router request or the daily cleanup, whichever comes first.

The enumerated values live in code: the task ids in `fixtures/catalog/tasks.json`,
`DIAGNOSTIC_CODES` and `DIAGNOSTIC_STAGES` in `diagnostics.ts`.
`docs/ENVIRONMENTS.md` covers the kill switch and the rate limits.
