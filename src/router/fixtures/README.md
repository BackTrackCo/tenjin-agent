# Shared wire fixtures

This directory, in `tenjin-agent`, is the **one canonical set**: the client
that consumes the contract owns it (consumer-driven contracts). `tenjin`
parses the same files with its own parser, so a shape only one side validates
is a contract only one side keeps. Four divergences so far (`pendingCall`, the
grouped arguments, the nested `diagnostics`, and three files copied by hand
that drifted by 2026-10-28) each cost a round trip; read these files rather
than hand-writing an equivalent. Until the server's CI reads them from here,
`tenjin` keeps a copy, refreshed from this one.

Change them in the same change as the client and server code that reads and
writes them. `harness/` is the exception: harness events (what Claude Code
hands a router hook) that only this client reads. `ROUTER_VERSION` is
`2026-10-24.1`.

## The calls

A lookup is calls to the paid `POST /api/x402-router/route`. The free `POST /api/x402-router` serves only the outcome report, `browse`, the `{tool}` spec read by browse id, and `{id, input}` (answered `needs_input`). Every form requires `accepts` to list `spec`:
each capability needs a client that runs its spec, so a client without it is
answered `native` with the `client_outdated` diagnostic, on every form, before
any model call. The free route `POST /api/x402-router` answers the routing forms `{packet}`
and `{query, id?}` with `native` and `fee_required` first, with or without `spec` (The paid path,
below). The outcome report is the one form that carries no `accepts`.

| call    | request                                                        | answer                                                                                                                      |
| ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| hook    | `{schemaVersion, packet, gateHint?, sessionId?, accepts}`      | `execute` with the id, the capability, its `specs` and a `hint`, `discovered`, or `native` / `needs_input` with diagnostics |
| tool    | `{schemaVersion, query, id?, accepts}`                         | `spec` for a query with no id, `execute` for the free docs lookup's id, `discovered`, or `native` / `needs_input`           |
| browse  | `{schemaVersion, browse, accepts}`                             | `{schemaVersion, routerVersion, rows}`: the tool list, free, with no gate call                                              |
| by id   | `{schemaVersion, tool, accepts}`                               | `spec` for a browse row's id under a fresh offer id, or `needs_input`                                                       |
| outcome | `{schemaVersion, id, status, reason?, httpStatus?, ms?, via?}` | an empty 204                                                                                                                |

Both `execute` answers name the capability: `capabilityId`, `category` (a
catalog task id, such as `web research`, at most 64 characters),
`provider` (the service's own name, such as `Wolfram Alpha`),
`capabilityDescription` (one line saying what it can do) and
`providerPriceAtomic`.

The hook answer adds the `id`, `endpoint` (the x402 URL the lookup pays),
`usage` (what to pass in `query`), `specs` and `hint`, the one line the host
injects verbatim: a line naming the service and the task is followed where a
generic one is not. The line is the call with its spec's input sketched in
(below). Before a native call runs the client denies it, so the line says to
call `request` instead and leaves native tools allowed for anything else; with
a `nativeOutcome` the call already ran, and the line says to call `request`
because that tool couldn't get it. The server builds every line, with the real
id in it. The free docs lookup has no spec: its line asks for
`request({query: <usage>, id})`, and that tool call is answered `execute` with
`contract`, the request built from the query (`request`, `arguments`).
A session's first Tenjin list offer (no `sessionId` counts as first) ends with
one sentence naming the list's other pieces, so the host learns what else it
can ask for. Later offers add the other media pieces only when the offer is
itself image, video or audio. Either sentence is dropped rather than overflow
the hint's bound.

The hook answer carries no contract. It carries the id, the offer line, and
the capability's spec. The host fills the fields; the client builds and pays
the call. There is no prepared decision, no binding on the server, and no id
to poll.

## The contract tokens

`accepts` names the contracts a client parses and runs, one token per kind of
feature (`CLIENT_CONTRACTS` and `CATALOG_ACCEPT` in `catalog.ts`). A token the
server does not know is ignored, never refused. Each capability names the
lowest token it needs (`minContract`, `spec` for all of them today), and the
gate is offered only the tasks whose capabilities a client runs.

- `spec`: tool specs, the floor every capability needs.
- `catalog`: a former Tenjin list service comes as a `discovered` offer under
  its catalog id, each spec with the `fields` below (a list service's `output`
  is `media`), and with `choices` when its service belongs to a compare group.
  A client without it runs a former list service only if it sends
  `discovered`, and gets the same offer under its old `discovered:tenjin:` id
  (Discovered services, below).
- `label`: display names. Each catalog capability's spec, both `execute`
  answers and the offer line carry its `label` (1 to 32 characters, such as
  `Exa search`), and the line starts at it and drops the URL the lookup pays:
  `Exa search, $0.007: <what it does>. Call request({…}) …`. A listed service's
  spec carries its label too, in a `discovered` answer as well; only a live
  open-Bazaar candidate's spec has none.
- `fields`: each spec carries `holds` (`{WebSearch?, WebFetch?}`, the input
  field that takes a pending search's query or fetch's URL) and `output`
  (`json`, `text`, or `media`, whose links the client saves; an open-Bazaar
  listing is `media`). The hook's `execute` answer carries `delivery`: for
  the free docs lookup before a search, `note` to a client that also sends
  `note`, else `augment` with `augmentUrl`, the GET the client makes to put
  the docs above the search's own results; `offer` for every other line the
  client shows.
- `note`: with `fields`, the free docs lookup before a search comes as
  `delivery: "note"` with no `augmentUrl`. The client lets the search run and
  shows the line after it, so the line is the conditional one a `nativeOutcome`
  gets: `If WebSearch couldn't get this, call request({query, id}) …`, with the
  search's own query.
- `jobs`: a listed service's spec carries `job` when its seller can answer
  before the result is ready (Job specs, below), and `takes: {max}` when its
  task makes media, the most takes one call's `count` may run (5). A service
  that never answers inline is offered at all, and a media offer's line names
  `count` after its call (`COUNT_LINE` in `policy.ts`), before the list's menu,
  dropped past the hint's bound.

- `headers` (client side only, until tenjin#988 lands): a spec carries
  `request.headers`, fixed headers the catalog sets on a service's call (a
  provider's beta opt-in), and the pins those headers unlock.

A client that does not send a token never sees its fields, so every answer to
it is byte for byte the shape above.

## Reading an answer

The client reads every answer as a tolerant reader (RFC 9413, and only that):

- A field it does not know is dropped, never refused, at any depth. A server
  that adds a field reaches every released client without a release or a
  deploy order.
- A field it knows keeps its type, its bounds and its checks (the tables
  below), and an object naming the keys of two arms of one union (a job's
  `pollUrl` with both `field` and `fixed`) is refused rather than read as one.
- An offer that a client must understand to run says so in `requires`: an
  array of up to 16 `accepts` tokens (`^[a-z][a-z0-9_-]{0,31}$`), on an
  offering answer (`execute`, `discovered`) or on any spec, the `spec`
  answer's included. A client without a listed feature skips that offer
  alone. A spec in `specs` it cannot run is dropped, with any `choices`
  option that runs it (and the set, once fewer than two options are left);
  when the offer is the answer's own (its `requires`, its own spec, or a
  `spec` answer's spec), the client treats the answer as `native` with the
  reason code `requires_unmet` and the missing tokens in `missing`. This
  client has `catalog`, `spec`, `label`, `fields`, `jobs`, `headers`, `note`
  and `bazaar`. Send `requires` for a field whose absence changes what the
  call is (a header it must send, a new kind of payment or streaming); a
  field a client may ignore needs none.

## The harness

Every form, the outcome report included, takes an optional `harness`: the
agent host the client runs in, `claude` or `codex`. It changes which services
the router offers, never payment, limits or the fee. A service the host's own
tools already cover is left out on every form: the hook and tool offers, a
page's routed reader, browse rows, `tool`, and an open-Bazaar listing at the
same endpoint. Codex gets no `glim-reddit-get`,
because its hosted web tool reads a Reddit thread from its URL, so that page
is answered `native`. No `harness` means `claude`, and an unknown token gets
the `claude` answer. The server logs the mapped value (`claude`, `codex` or
`other`) and never the raw token.

A browse (`browse`, any words, or empty for everything) answers rows of
`{id, label, does, price, free, kind}`: every catalog capability the client
runs, former list services included, best match first, or grouped by kind
when empty. `price` is as a person reads it (`1¢`, `free`). No
gate, no Jev, no row stored. A row's id sent as `tool` answers its spec under
a fresh offer id, stored as a query's pick is; the free docs row has no spec
and answers `needs_input` (`spec_missing`), pointing at `request({query})`.

## The paid path

`POST /api/x402-router/route` takes the hook and the tool's `{query, id?}` forms,
behind x402
`batch-settlement` at 3000 atomic USDC (`maxTimeoutSeconds` 15). The 402 is the
only price: this client pays any quote at or below its ceiling of 3000 atomic
USDC (`ROUTING_FEE_CEILING_ATOMIC` in `fee.ts`) inside the user's spend limits,
pays nothing above it, and pins no payee. With the fee `off`, the route answers
with no 402. An answer from
a completed Jev gate settles that fee; any other answer settles at 0, which
`PAYMENT-RESPONSE` shows as `chargedAmount: "0"`. An outcome report or an
`{id, input}` there is a 400. A new channel's deposit rides its first paid
call. The free route answers `{packet}` and `{query}` with `native` and the
`fee_required` diagnostic, telling the agent to update tenjin-cli. Outcome
reports, `browse` and `tool` stay on the free route.

## Discovered services

When the gate picks a task a former Tenjin list service leads, the router
names that service as a pay-per-call service: x402 endpoints Tenjin reviewed
by hand, now in the catalog (`source: "tenjin"`), under its catalog id for a
client that sends `catalog` and its old `discovered:tenjin:` id for one that
sends `discovered`. When the gate finds no catalog task, Coinbase's open x402
Bazaar is a second, experimental source (`source: "bazaar"`) searched only for
a client whose `accepts` also includes `"bazaar"`. Only a client that sends
`catalog` or `discovered` is ever answered with one; a client that sends
neither sees exactly the three actions above. The hook's `sessionId` (the
harness session, at most 200 characters) is read so one session is not
offered the same list service again while its earlier offer is live (about 15
minutes), and so the list's menu sentence goes out once per session.

A `discovered` answer carries the `id`, the `candidate` (`source`, `provider`,
`url`, `method`, `description`, `providerPriceAtomic`, `network`, `payTo`, and
`input`: where the input goes, `body` or `query`, and its JSON Schema) and a
`hint` the server wrote, with each service's spec in `specs`. When up to
three services fit, `id` and `candidate` are the first one and the
`hint` names each, with its own id. A Tenjin list candidate's description is
ours; a Bazaar one's text is the seller's own listing, bounded and stripped of
control characters. The agent decides whether to use it and fills the spec;
the client builds and pays the call. An `{id, input}` that reaches the server
means the client no longer holds that spec, and is answered `needs_input`
(`spec_missing`), pointing at a fresh `request({query})`; nothing is built.

The tool answers `discovered` too: a `query` whose pick is a former list
service, and a `query` whose decision does not execute, from a client that
sends `bazaar`, can come back with a fresh id and a candidate in the same
shape.

The hook's `pendingCall` can also be `{tool: "AskUserQuestion", question}`:
the question the host is about to put to the user, its option labels and
descriptions joined. After the user answers, the client sends an ordinary
prompt-shaped packet whose `current` is the user's answers.

Anything that is neither form is refused at validation with a plain error:
`{packet, id}`, `{id}` alone and an empty body all fail. A `query` with an id
that has expired is answered as a query with no id; the answer says so in
`note` and is still a decision.

## Tool specs

A client that adds `"spec"` to `accepts` also gets `specs` on every offer
(`execute` and `discovered`): one spec per service the hint names, under the
id the hint gives it. A spec is the service's contract: `capabilityId`,
`provider`, `description`, `priceAtomic`, `priceVaries`, `maxAmountAtomic`,
`payTo`, `network`, `asset`, `request` (`method`, a `url` that may hold
`{name}` path placeholders, `fields` saying where each field goes, and
`location` for any other), `input` (a flat JSON Schema), `pinned` (fields set
on every call, which win over the agent's input), and optionally `example`,
`returns`, `returnsExample`, `resultSchema`, `outputSchema`, `timeoutS` and
`maxBytes`. `timeoutS` (whole seconds, 1 to 120) is the provider call's own
deadline: the unpaid probe's, and the least the paid leg waits (it still waits
up to the 402's `maxTimeoutSeconds`, within 120 s). `maxBytes` (1 to
209715200, 200 MiB) caps a binary result and each file a media result links
to. Without them the client keeps its own: its `--timeout` and 200 MiB. `outputSchema`
names the fields a result promises, in `type`, `properties`, `items` and
`required` only: the client checks `resultSchema` on the whole body, then shows
the agent a copy holding only those fields (a node with `properties` keeps
those, `items` applies to each element, any other node is kept whole).

An offer whose capability has a batch form (Apollo's company profile by domain
and its 2-to-10 `bulk_enrich`) names both calls in its line, each under its
own id with its own spec in `specs`; the host knows how many it has and picks.

The hint is then the one call to make, `request({id, input: {...}})`, with a
skeleton for `input`: the spec's required fields, each with a short
`"<placeholder>"`, except that a field the hook already holds (a pending
search's text in the search field, a pending fetch's URL in a page reader's
field) carries that value, a `const` or one-value enum carries its value, a
field with a schema `default` carries the default, an enum of up to four
values shows them as `"<a|b|c>"`, an object field shows its own required
fields (else its example's field names, never their values) by these same
rules, and a number or boolean with no default names the example's value in
its placeholder (`"<how many results, e.g. 10>"`), never the bare value, which
would read as chosen and override a count the user asked for.
Optional and pinned fields stay out; a spec that names no required field (its
rule is a set of fields, or a count) shows its example's fields. The client builds and pays the
call itself and reports how it ended, `{schemaVersion, id, status, reason?,
httpStatus?, ms?}`, with the provider's HTTP status whenever it is known. A call
stopped before anything was signed is `unpaid`, with a `reason` (`input`,
`terms`, `provider`, `unreachable` or `wallet`). A paid call whose result was
still rendering when it ended is `running`. The first report of a call that
ran (`fulfilled`, `unverified`, `failed` or `running`) for a live id marks its
row executed; `unpaid`, `needs_approval`, a repeat or a report after expiry is
a 204 that changes nothing, so a job's later `fulfilled` is only logged. A
`fulfilled` or `unverified` report with `httpStatus` 202 is logged as `running`:
a 202 is a queued job, not a result. No
text is stored.

The report is one form, discriminated on `status`, and any caller may post it:

| `status`                              | fields beside `schemaVersion`, `id` and `status`          |
| ------------------------------------- | --------------------------------------------------------- |
| `fulfilled`, `unverified`             | `httpStatus?`, `ms?`, `result?` (`useful` or `bad`)       |
| `failed`, `needs_approval`, `running` | `httpStatus?`, `ms?`                                      |
| `unpaid`                              | `reason`, `httpStatus?`, `ms?`                            |
| `chose_other`                         | `host`, the bare hostname used instead, at most 253 chars |

`id` is the answer's decision id, or its `x-request-id` when it carried none
(a `native` or `needs_input`). `via`, optional on every status, is a bare
token naming the path that made the call (`swap`). A field the shape does not
name is dropped, never refused, so a later telemetry field needs no
coordinated release; a named field with a bad value is a 400. Every post is
logged with its raw id and answered 204, whether or not the id was ever
issued.

A tool call with a `query` and no `id` runs the hook's gate over the query (a bare URL takes the page rule)
and answers `{action: "spec", id, spec, hint}`: the picked
capability's spec under a fresh id, stored as a hook offer is, and the
skeleton line. The skeleton carries the value the hook holds (a page URL, or a
search with its `site:` moved where the service takes it). This call only
selects and never pays: the agent fills the skeleton and
calls `request({id, input})`. A pick that is a former list service, and a
query no capability serves, can still come back `discovered`, both with
`specs`; a pick with no spec (the free docs lookup) is bound and answered
`execute` as its id would be.

## Job specs

A `jobs` client's spec carries `job` for a service whose seller can answer a
paid call before its result is ready (Treza's renders, AiSpace's queued video
and audio). Every poll is sent unsigned:

- `pollUrl`: where the status is. `{field?, header?}` names a field or a header
  of the submit's 2xx answer (at least one); `{fixed}` is one URL. A fixed URL
  is on the host of `request.url`; a URL an answer names is the client's to
  check against the same host.
- `pollMethod`: `GET` or `POST`. Only a `POST` has `pollBody`, whose values
  `$input.<field>` and `$result.<field>` name a field of the body the submit
  sent (pins included) or of its answer; any other value is sent as written.
- `running`: `{httpStatus}`, the 2xx statuses that mean still running, or
  `{field, values}`, a body field and the values that mean it. `failed`, when
  present, is `{field, values}` the same way.
- `completeUrl`, when present: `{fixed}`, one URL on the same host, sent once
  with the poll's method and body after the result is saved, which frees
  the seller's copy (AiSpace's `/complete`); its answer is ignored, and it is
  never sent when the save failed.
- `everyS`: the first poll's interval. `maxWaitS`: how long after the submit
  the result can still arrive. `keepH`: how many hours the job can be resumed.
- `always: true`: the seller never answers inline, so the submit's 2xx is a
  running job whatever `running` says. Such a service needs `jobs`
  (`minContract`), so no other client is offered it.

## Compare choices

A client that sends `catalog`, or adds `"choices"` beside `discovered`, may get
`choices` on a `discovered` answer whose offered service belongs to a compare
group on the Tenjin list (`image-frontier`: GPT Image 2.5 Sunburst and Nano
Banana 2.1). `choices` is `{group, default, input, options, all}`:
`options` lists the group's 2 to 4 members in the group's order, each
`{key, label, strength, id}` under its own offer id with its spec in `specs`;
the `default` option's id is the decision's `id`, and its spec comes first.
`input` names the fields every option takes (`["prompt"]`), and
`all.totalAtomic` is every option's price added. The `hint` names each key,
its price and the `all` total, and the one call, `request({id, choice,
input})`, where `choice` is a `key` or `all`; it tells the host to use the
model the user named, else to ask a person present once, else to take the
default. The client runs each chosen option from its own spec as its own
payment and reports each outcome under that option's id. Without `catalog` or
`"choices"` the answer is unchanged: no `choices`, and at most four specs.

## The set

| file                                       | what it pins                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `wire-gate-request.json`                   | the free gate request, including a pending native call                                    |
| `wire-decision-request.json`               | the hook call: a packet, no query                                                         |
| `wire-decision-request-narrowed.json`      | the tool call: the query and the id                                                       |
| `wire-hook-execute.json`                   | hook answer for the free docs lookup: no spec, the `request({query, id})` line            |
| `wire-hook-native.json`                    | hook answer: the host's own tools are enough                                              |
| `wire-hook-needs-input.json`               | hook answer: the turn names no task a capability serves                                   |
| `wire-lookup-native.json`                  | tool answer: native, with diagnostics                                                     |
| `wire-lookup-needs-input.json`             | tool answer: a named missing argument                                                     |
| `wire-lookup-expired-id.json`              | tool answer after a dead id, carrying the plain `note`: the free docs lookup's `execute`  |
| `wire-hook-request-native-shortfall.json`  | the native hook after WebFetch fell short: `nativeOutcome` beside its `pendingCall`       |
| `wire-hook-request-native-no-content.json` | the native hook after WebFetch answered 200 with only the page shell: `reason`            |
| `wire-hook-request-ask.json`               | the hook before a question to the user, with `sessionId` and `accepts`                    |
| `wire-hook-discovered.json`                | hook answer: a discovered service, its candidate and the server's `hint`                  |
| `wire-lookup-discovered.json`              | tool fallback answer: the same `discovered` shape with a fresh id                         |
| `wire-hook-execute-spec.json`              | hook answer for a client that accepts `spec`: the call with the held search, the Exa spec |
| `wire-hook-execute-headers.json`           | the same for a `headers` client: the Exa spec with its `Exa-Beta` header (tenjin#988)     |
| `wire-hook-discovered-spec.json`           | the same for a list service: the call with its skeleton, the spec rides along             |
| `wire-outcome-request.json`                | the outcome report a client sends after running a spec                                    |
| `wire-outcome-result.json`                 | the same report with the caller's verdict, `result`                                       |
| `wire-outcome-chose-other.json`            | a report that the caller used another service, named by `host`                            |
| `wire-outcome-unpaid.json`                 | a call stopped before anything was signed, with its `reason`                              |
| `wire-tool-request-spec.json`              | the tool call from a spec client: a query, no id                                          |
| `wire-lookup-spec.json`                    | tool answer for it: Wolfram's spec under a fresh id and its skeleton line, no `input`     |
| `wire-lookup-spec-skeleton.json`           | tool answer for a spec with more to fill (Apollo): the skeleton line, no `input`          |
| `wire-hook-request-choices.json`           | the hook from a client that accepts `choices`                                             |
| `wire-hook-discovered-choices.json`        | hook answer: a compare group's options, each under its own id and spec, and the one line  |
| `wire-lookup-discovered-choices.json`      | tool fallback answer: the same `choices` shape with fresh ids                             |
| `wire-hook-execute-labelled.json`          | hook answer for a `label` and `fields` client: the label, the short line, the fields      |
| `wire-hook-execute-augment.json`           | the free docs lookup before a search, for a `fields` client: `augment` and `augmentUrl`   |
| `wire-hook-execute-note.json`              | the same for a `fields` and `note` client: `note`, the after-search line, no `augmentUrl` |
| `wire-browse-request.json`                 | a browse of the tool list                                                                 |
| `wire-browse.json`                         | the browse answer: its rows                                                               |
| `wire-tool-request-by-id.json`             | a browse row's id sent as `tool`                                                          |
| `wire-lookup-spec-by-id.json`              | tool answer for it: the row's spec under a fresh id, labelled, with the fields            |
| `wire-outcome-via.json`                    | an outcome report naming the path that made the call, `via`                               |
| `wire-hook-request-catalog.json`           | the hook from a client that sends `catalog` (and `bazaar`)                                |
| `wire-hook-discovered-catalog.json`        | hook answer: a former list service as `discovered` under its catalog id, with its fields  |
| `wire-hook-request-harness.json`           | the native hook from a Codex client: `harness`, before a Reddit thread fetch              |
| `wire-tool-request-catalog.json`           | the tool call from a `catalog` client: a query, no id                                     |
| `wire-lookup-discovered-catalog.json`      | tool answer for it: two former list services as `discovered`, under their catalog ids     |
| `wire-lookup-spec-job.json`                | a row's spec for a `catalog`, `spec`, `jobs` client: `job`, `takes`, the line's `count`   |

Two rules the fixtures exist to hold:

- **In an offer, the line and its `specs` name the same ids.** A caller cannot
  approve one service and run another. A compare choice's line names the
  decision's id and `choices` names the rest, each with its spec.
- **Every non-execute answer carries `diagnostics`, nested inside `decision`.**
  That is the intended shape: they sit on the union's non-execute arms so a
  contractless outcome without diagnostics does not typecheck.

There is no `billing` block and no fee. The decision is free; the one payment in
a lookup is the caller's own, to the provider.

## Bounds both sides enforce

Take these from here; do not re-derive them.

| field                           | bound                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                 | exactly `1`, on every request and response                                                                                                                                                                  |
| hook vs native hook             | read from `packet.pendingCall`; there is no `source` field                                                                                                                                                  |
| `packet` serialized             | 16384 bytes, refused rather than truncated                                                                                                                                                                  |
| `packet.history`                | 6 messages                                                                                                                                                                                                  |
| message `text`                  | 16000 characters                                                                                                                                                                                            |
| `packet.literalUrls`            | 8 entries, each 2000 characters                                                                                                                                                                             |
| `query`                         | 1 to 8000 characters; optional only when `input` and `id` are sent                                                                                                                                          |
| `input`                         | a JSON object, at most 16384 bytes serialized; only with an `id`, and answered `needs_input`                                                                                                                |
| `accepts`                       | up to 16 strings, each 1-32 characters; `spec` is required; the server also reads `catalog`, `label`, `fields`, `jobs`, `discovered` (the list), `bazaar` (the open Bazaar) and `choices` (compare options) |
| `browse`                        | 0 to 8000 characters                                                                                                                                                                                        |
| `tool`                          | 1 to 200 characters, a browse row's `id`                                                                                                                                                                    |
| `label`                         | 1 to 32 characters on a spec or an `execute`; up to 120 on a browse row (a list entry's upstream)                                                                                                           |
| `via`                           | a lowercase token, 1 to 32 characters, letters and `_`                                                                                                                                                      |
| `harness`                       | a lowercase token, 1 to 32 characters, starting with a letter, then letters, digits, `_` and `-`                                                                                                            |
| `sessionId`                     | 1 to 200 characters, hook call only                                                                                                                                                                         |
| `pendingCall.query` / `.url`    | 1 to 4000 characters                                                                                                                                                                                        |
| `pendingCall.question`          | 1 to 4000 characters                                                                                                                                                                                        |
| `packet.nativeOutcome`          | optional; only with a `pendingCall`; at least one of `code` (0 to 999), `bytes` (0 or more), `error` (1 to 1000 characters); `reason` optional, one of `no_main_content`                                    |
| `gateHint.turnId` / `.lookupId` | 1 to 64 characters                                                                                                                                                                                          |
| `job`                           | integers `everyS` 1 to 30, `maxWaitS` 1 to 600, `keepH` 1 to 48; a field name 1 to 64 of `[A-Za-z0-9_]`, no leading digit; a header 1 to 64 of `[A-Za-z0-9-]`; `httpStatus` and `values` 1 to 8 entries     |
| `diagnostics.missing`           | 60 entries, each non-empty                                                                                                                                                                                  |
| `id`                            | a uuid the server minted; a client never invents one                                                                                                                                                        |
| id lifetime                     | 15 minutes from the hook call that created it                                                                                                                                                               |

Expired packets are unreadable after 15 minutes (the route refuses an expired id) and are deleted by the next router request or the daily cleanup, whichever comes first; a discovery run's search text (built from the user's words) is cleared at the same expiry.

The enumerated values live in code: the task ids in `fixtures/catalog/tasks.json`,
`DIAGNOSTIC_CODES` and `DIAGNOSTIC_STAGES` in `diagnostics.ts`.
`docs/ENVIRONMENTS.md` covers the kill switch and the rate limits.
