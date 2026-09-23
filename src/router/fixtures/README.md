# Shared wire fixtures

This directory is the **one canonical set**. `tenjin-agent` carries the same
files byte for byte and parses them with its own parser, so a shape only one side
validates is a contract only one side keeps. Three divergences so far
(`pendingCall`, the grouped arguments, and the nested `diagnostics`) each cost a
round trip; copy these files rather than hand-writing an equivalent.

Change them here, in the same commit as the `wire.ts` change that makes them
valid, then copy them across. `ROUTER_VERSION` is `2026-09-23.1`.

## The two calls

A lookup is two calls to ONE route, and they ask different questions. There is
no separate gate endpoint: each call has one schema and one set of fixtures,
parsed by the handler that serves it.

| call | request                                  | answer                                                                                                  |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| hook | `{schemaVersion, packet, gateHint?}`     | is a paid lookup worth offering? `{action:'execute', id}`, or `native` / `needs_input` with diagnostics |
| tool | `{schemaVersion, query, id?, gateHint?}` | the decision: the capability, its price and the contract together, or `native` / `needs_input`          |

The hook answer carries **no** capability, price or contract. The hook has the
user's words but not the task the host will run, so anything quoted there would
be a guess a caller reads as an offer. The tool call makes the one decision,
from its query plus the packet the id is holding. That pair is what the routing
corpus is calibrated on: **55 of 56** against **53 of 56** from the prompt alone,
with the misses in exactly the mixed turns a shortcut looks fastest on.

There is no prepared decision, no background binding, and no id to poll.

Anything that is neither form is refused at validation with a plain error:
`{packet, id}`, `{id}` alone and an empty body all fail. A `query` with no `id`
is valid and is the fallback for an id that has expired; the answer says so in
`note` and is still a decision.

## The set

| file                                  | what it pins                                                      |
| ------------------------------------- | ----------------------------------------------------------------- |
| `wire-gate-request.json`              | the free gate request, including a pending native call            |
| `wire-decision-request.json`          | the hook call: a packet, no query                                 |
| `wire-decision-request-narrowed.json` | the tool call: the query and the id                               |
| `wire-hook-execute.json`              | hook answer: the id, and nothing else                             |
| `wire-hook-native.json`               | hook answer: the host's own tools are enough                      |
| `wire-hook-needs-input.json`          | hook answer: the turn names no task a capability serves           |
| `wire-lookup-execute-get.json`        | tool answer: a GET contract with its built query string           |
| `wire-lookup-execute-post.json`       | tool answer: a POST contract whose body is the serialized request |
| `wire-lookup-native.json`             | tool answer: native, with diagnostics                             |
| `wire-lookup-needs-input.json`        | tool answer: a named missing argument                             |
| `wire-lookup-expired-id.json`         | tool answer after a dead id, carrying the plain `note`            |

Two rules the fixtures exist to hold:

- **The provider named in `description` and the provider in `contract` are one
  decision.** They are produced together, so a caller cannot approve one offer
  and receive another.
- **Every non-execute answer carries `diagnostics`, nested inside `decision`.**
  That is the intended shape: they sit on the union's non-execute arms so a
  contractless outcome without diagnostics does not typecheck.

There is no `billing` block and no fee. The decision is free; the one payment in
a lookup is the caller's own, to the provider.

## Bounds both sides enforce

Take these from here; do not re-derive them.

| field                           | bound                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| `schemaVersion`                 | exactly `1`, on every request and response                 |
| hook vs native hook             | read from `packet.pendingCall`; there is no `source` field |
| `packet` serialized             | 16384 bytes, refused rather than truncated                 |
| `packet.history`                | 6 messages                                                 |
| message `text`                  | 16000 characters                                           |
| `packet.literalUrls`            | 8 entries, each 2000 characters                            |
| `query`                         | 1 to 8000 characters                                       |
| `pendingCall.query` / `.url`    | 1 to 4000 characters                                       |
| `gateHint.turnId` / `.lookupId` | 1 to 64 characters                                         |
| `diagnostics.missing`           | 60 entries, each non-empty                                 |
| `id`                            | a uuid the server minted; a client never invents one       |
| id lifetime                     | 15 minutes from the hook call that created it              |

The enumerated values live in code: `ROUTER_CATEGORIES` in `wire.ts`,
`DIAGNOSTIC_CODES` and `DIAGNOSTIC_STAGES` in `diagnostics.ts`.
`docs/ENVIRONMENTS.md` covers the kill switch and the rate limits.
