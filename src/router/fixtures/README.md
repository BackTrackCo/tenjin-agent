# Shared wire fixtures

This directory is the **one canonical set**. `tenjin-agent` carries the same
files byte for byte and parses them with its own parser, so a shape only one side
validates is a contract only one side keeps. Three divergences so far
(`pendingCall`, the grouped arguments, and the nested `diagnostics`) each cost a
round trip; copy these files rather than hand-writing an equivalent.

Change them here, in the same commit as the `wire.ts` change that makes them
valid, then copy them across. `harness/`, in tenjin-agent alone, is the
exception: harness events (what Claude Code hands a router hook) that only the
client reads, never copied. `ROUTER_VERSION` is `2026-10-23.3`.

## The calls

A lookup is calls to ONE route. Every form requires `accepts` to list `spec`:
each capability needs a client that runs its spec, so a client without it is
answered `native` with the `client_outdated` diagnostic, on every form, before
any model call. While the fee is `required`, the free route answers `{packet}`
and `{query}` with `fee_required` first, with or without `spec` (The paid path,
below). The outcome report carries no `accepts`, and the directory reads only
`mcp` from its own.

| call      | request                                                            | answer                                                                                                                      |
| --------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| hook      | `{schemaVersion, packet, gateHint?, sessionId?, accepts, policy?}` | `execute` with the id, the capability, its `specs` and a `hint`, `discovered`, or `native` / `needs_input` with diagnostics |
| tool      | `{schemaVersion, query, id?, accepts, policy?, override?}`         | `spec` for a query with no id, `execute` for the free docs lookup's id, `discovered`, or `native` / `needs_input`           |
| browse    | `{schemaVersion, browse, accepts, policy?}`                        | `{schemaVersion, routerVersion, rows}`: the tool list, free, with no gate call                                              |
| by id     | `{schemaVersion, tool, accepts, policy?}`                          | `spec` for a browse row's id under a fresh offer id, or `needs_input`                                                       |
| directory | `{schemaVersion, directory: {ifRevision?}, accepts?}`              | `{schemaVersion, routerVersion, directory}`: every id a setting can name, free, or `unchanged`                              |
| outcome   | `{schemaVersion, id, status, reason?, httpStatus?, ms?, via?}`     | an empty 204                                                                                                                |

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
  `Exa search, $0.007: <what it does>. Call request({…}) …`. A discovered
  service's spec has none.
- `fields`: each spec carries `holds` (`{WebSearch?, WebFetch?}`, the input
  field that takes a pending search's query or fetch's URL) and `output`
  (`json`, `text`, or `media`, whose links the client saves; an open-Bazaar
  listing is `media`). The hook's `execute` answer carries `delivery`:
  `augment` for the free docs lookup before a search, with `augmentUrl`, the
  GET the client makes to put the docs above the search's own results, and
  `offer` for every line the client shows.
- `jobs`: a listed service's spec carries `job` when its seller can answer
  before the result is ready (Job specs, below), and `takes: {max}` when its
  task makes media, the most takes one call's `count` may run (5). A service
  that never answers inline is offered at all, and a media offer's line names
  `count` after its call (`COUNT_LINE` in `policy.ts`), before the list's menu,
  dropped past the hint's bound.
- `identity`: every spec and both `execute` answers carry `identity`, the
  route as the user's settings read it (Settings, below). The free docs lookup
  has no spec, so its `execute` is the only place it has one.
- `bound`: before a native search or fetch runs (the hook, a `pendingCall` of
  `WebSearch` or `WebFetch`, no `nativeOutcome`), an `execute` or `discovered`
  answer whose lead has a spec and no `choices` may carry `bound`: the complete
  input for the spec under the decision's `id`, from that native call, pins
  left out. The client runs it unchanged in the native call's place, through
  its ordinary executor, or not at all; it never edits it. Never for the free
  docs lookup, an `augment` or an account lead.
- `mcp`: services on the user's connected accounts (Connected accounts,
  below): a spec whose call is an MCP tool call on that account, the
  `execute` that offers one with no `endpoint`, the `fallback` beside it, and
  `connectable` in the directory. It counts only beside `identity`, which an
  account spec always carries, and an account service needs it (`minContract`).

A client that does not send a token never sees its fields, so every answer to
it is byte for byte the shape above. Neither `policy`, `override` nor the
directory is a token: they are request content, and a server without them
answers them 400.

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

`POST /api/x402-router/route` takes the hook and the tool's `{query, id?}` forms
with the same bodies and answers as the free route, behind x402
`batch-settlement` at 3000 atomic USDC (`maxTimeoutSeconds` 15). An answer from
a completed Jev gate settles that fee; any other answer settles at 0, which
`PAYMENT-RESPONSE` shows as `chargedAmount: "0"`. An outcome report or an
`{id, input}` there is a 400. A new channel's deposit rides its first paid
call. The path is 404 until the deployment's `X402_ROUTER_FEE` leaves `off`; once it is `required`,
the free route answers `{packet}` and `{query}` with `native` and the
`fee_required` diagnostic, telling the agent to update tenjin-cli. Outcome
reports, `browse`, `tool` and the directory stay on the free route.

## Settings

The hook, tool, browse and by-id forms (and the paid path's two) take
`policy`, the user's saved routing rules, and the tool's `query` takes
`override`, one request's narrowing. Code enforces both; Jev never sees them.
A client with no rules sends neither, so its bodies and answers are unchanged.
A server that does not know them answers 400, and the client refuses rather
than run unrestricted.

A target is `{kind, id}`, `kind` one of `category`, `task`, `provider`,
`seller`, `service` or `source`; a scope is `{kind: "global"}` or
`{kind: "task", id}`. `policy` is `{version: 1, revision?, sources?, block?,
only?, prefer?}`:

- `block`: targets, any kind, global.
- `only`: `{scope, dimension, targets}`. `capability` takes category and task
  targets and only the global scope; `provider`, `seller` and `service` take
  targets of their own kind.
- `prefer`: `{scope, targets}`, ordered, all of one kind: `source` for the
  global scope, `provider`, `service` or `source` for a task.
- `sources`: the connected accounts this machine holds both a description and
  a credential of, among those the directory listed as `connectable` when
  they were connected. An account connected by its address alone is never
  listed: the router has no service on it. `tenjin`, the source of every
  catalog service and open-Bazaar listing, is implied and never listed. A
  route on any other source is `unavailable` (Connected accounts, below).
- `revision`: the first 16 hex of sha256 over the rest, its keys sorted at
  every level and no whitespace (`contractHash` in `contract.ts`). Logged,
  never authority.

`override` is `{only?, prefer?}`, at least one: `only` entries
`{dimension, targets}`, global, under the same kind rules; `prefer` targets of
one kind out of `provider`, `service` and `source`. It narrows and re-ranks; it
never widens, connects, raises a limit or turns on replacement.

Each is a 400 `validation_failed` with a wrong `version`, two `only` entries
for one scope and dimension (one dimension, in an override), two `prefer`
entries for one scope, a target of the wrong kind or mixed kinds, a duplicate
target or source, `tenjin` in `sources`, an override beside no `query`, or a
`policy` over 16384 bytes serialized. An id the catalog does not know (unknown
or retired) is valid: a block on it matches nothing and an only on it admits
nothing.

Whether a route may run (`allowed` in `access.ts`; `wire-policy-cases.json`
pins it for both sides), checked in order, the first failure being the rule
reported: its source is `tenjin` or in `sources` (else `unavailable`); no
`block` matches it; every saved `only` that applies (global, or scoped to its
task) admits it, then every `override.only`. A category matches the tasks it
holds. A provider block matches a route through that provider, sold by anyone;
a provider only needs every one of the route's providers named. A route of
unknown upstream (an open-Bazaar listing: `providers: []`, no `seller`, no
`task`) matches every provider and seller block and satisfies no provider,
seller or capability only. A preference never refuses.

Allowed routes rank by the request's preference, else the task's saved one;
then the global source preference; then catalog order. A `tool` id and a free
docs `{query, id}` are exact and never ranked.

Every form that offers, specs or lists a service applies them: the hook and
the query offer only allowed services (a batch form, a compare option and the
list's menu included), browse lists only allowed rows, and an open-Bazaar
listing is dropped before its pick, as is one at the endpoint of a catalog
service the rules exclude. A page read's reader is picked by the page
first: a rule against the reader a route or the user's message names refuses
the page rather than move it, and a preference ranks only the readers serving
the same need.

When no allowed service serves the step, the answer is `native` with
`policy_refused` (stage `policy`): the gate's task is never relabelled, and
`diagnostics.rule`, `{from, kind, target?, scope?, dimension?}`, names the rule
the first runnable service in catalog order failed. `reason` states it with
the directory's labels: "Your Tenjin settings block Firecrawl." Only a request
that carried `policy` or `override` gets one. A refusal made before any gate
call settles the paid fee at 0.

### Identity

`identity` is `{service, source, providers, seller?, task?, categories,
revision}`, built from reviewed catalog data, never from a display name or a
hostname. `service` is the catalog id (an open-Bazaar listing's
`discovered:bazaar:` id). `providers` names every upstream party, sorted: the
maker and every named intermediary, so AiSpace's Nano Banana, sold through
Venice, is `["google", "venice"]`. `seller` is who sells the call, `task` is
the wire's `category`, and `categories` are those whose membership holds the
task. `revision` is the first 16 hex of `contractHash` over the six fields
before it: it changes exactly when one of them does, so an unrelated catalog
change keeps a saved offer valid.

### The directory

`{schemaVersion, directory: {ifRevision?}}` answers, free and unfiltered by
settings, `directory`: `revision`, the catalog's ETag, and `categories` (with
their `tasks`), `tasks`, `providers`, `sellers`, `sources` (`{id, label}`
each), `services` (`{id, label, identity}`, every catalog service) and
`retired` (`{kind, id, label}`, ids a saved rule may still name). With
`ifRevision` equal to the current revision it answers `{revision, unchanged:
true}`. No gate, no Jev, no payment and no row; it is answered before the fee
and the contract filter, and the paid path does not take it. A client resolves
a typed name against it and rechecks a saved offer's `identity.revision`.

## Connected accounts

A user can connect their own account at a provider, such as Apify, fal or
Firecrawl. Its mapped services do catalog tasks on that account, and the
user's own plan pays for them: the balance pays none of it, and the daily and
per-call limits do not cover it. An account service's `identity.source` is the
account's id (`apify`), never `tenjin`, and it runs only where
`policy.sources` lists that id. An account maps every task its tools can do,
and connecting makes all of them eligible, never first: a service ranks first
only through the visible source preference that connecting writes, and that
preference covers only the services the catalog marks `useFirst`. Only a
client that sends `mcp` beside `identity` is offered one.

### The account spec

An account service's spec has a paid spec's `capabilityId`, `provider`,
`label?`, `holds?`, `output?`, `description`, `input`, `pinned`, `example?`,
`returns?`, `returnsExample?`, `resultSchema?` and `outputSchema?`. In place of
a price and a request it has:

- `mcp`: the call, `{tool, args, result, next?}`.
- `identity`, always: the client attaches the credential it holds for
  `identity.source` and calls the MCP server it connected for that account.
  No URL and no credential travels, so no answer can send a user's token
  anywhere else.
- `verified`: Tenjin has checked this map with a real call.

It never has `job` or `takes`: one call is one run on the user's account, and
nothing of Tenjin's caps what that plan bills.

`args` is the tool's `arguments` as a template. `pinned` is merged into the
input first, as on a paid spec. Then:

- A value that is exactly `"{field}"` is that input field's value, of its own
  JSON type. When the field is absent, the key or array element holding it is
  dropped, so a map makes every cost-driving input required, with a schema
  maximum, or pins it.
- A value that is exactly `"{result.<path>}"`, a dotted path of up to four
  names, is allowed in a follow-up only: the value at that path in the first
  call's result. When it is missing, the call stops there.
- Any other value, braces inside a longer string included, is sent as written.
  That is how a map pins a tool's settings: an Actor, a model, a spending cap,
  one image.

Every `{field}` names a property of `input`, and the whole call, `next`
included, serializes to at most 8192 bytes.

`result` says how a tool's answer is read: `structured` is its
`structuredContent`; `json-text` is the JSON its text items hold, joined in
order; `content` is its content items as they come, text and the image or
audio media the client saves. An answer with `isError` is a refusal (below).
The client checks `resultSchema` on the final result and gives the agent a copy
trimmed to `outputSchema`, as on a paid spec.

`next` is the follow-up for a first call that does not hold the result,
`{when?, poll?, tool, args, result}`:

- Without `when` it always runs: Apify's `call-actor`, then
  `get-dataset-items` with the run's dataset,
  `{result.storages.datasets.default.id}`. With `when: {path, values}`
  it runs only when the first result's value at `path` is one of `values`:
  fal's `run_model` answering `processing`.
- `poll`, `{tool, args, result, running, failed?, everyS, maxWaitS}`, is a
  status call sent before the follow-up, every `everyS` seconds while its own
  result is in `running` (`{path, values}`). `failed` stops the call; past
  `maxWaitS` seconds from the first call, it ends unfinished.
- The call that bills is sent once, and never again because its job is still
  running: only `poll` repeats. A spec whose `poll` or follow-up names the
  first call's `tool` is refused.

The final result is the follow-up's when it ran, else the first call's.

### Offers on an account

The router suggests an account service on its own only when it is `verified`.
An unchecked one runs only when the request names it: a `query` whose
`override` prefers its source or the service, or only admits the service, or
its id sent as `tool`. The hook carries no override, so it offers checked
services alone. Browse lists checked ones, with `price` reading `your <label>
account` and `free` false. Among the services a request allows, an account's
follow Tenjin's own in catalog order, so one leads only through a preference:
the account-wide source preference connecting writes, a task's own, or the
request's. The account-wide one covers only the services the catalog marks
`useFirst`; it passes over the rest, which keep their catalog place, after
Tenjin's own. Such a service still runs when a request or a task's preference
names it, when no Tenjin route for the task is left (the rules block it, or
this client does not run it), and when the user uses only their own accounts.

An account lead goes out as the hook's `execute` or the tool's `spec`, alone:
never a batch sibling, a compare option or on a `discovered` offer, and never
with `bound`, so it never runs in place of a native call. Its `execute`
carries no `endpoint`, a `providerPriceAtomic` of `"0"` and the lead spec's
`identity`, and its line names the account by label with no price: `Apify
Google Maps, your Apify account: …`. So once a preference puts an account first
for a native call its map holds (Firecrawl's scrape holds `WebFetch`, its search
`WebSearch`), that call is denied and offered, and Tenjin's own pick no longer
runs in its place automatically. When the account maps the task more than once
(fal's edit, background removal and upscale), the lead is the one of them the
request needs, as the list's pick chooses.

Beside the lead, both answers carry `fallback`: Tenjin's own route for the
same task, a paid spec with its `identity` (`source: "tenjin"`) and its price,
under its own offer id. The line does not name it. When the account refuses
the call (its sign-in expired, its plan or rate limit ran out), the client
stops, charges nothing, and offers the fallback as the next step. It runs the
fallback only when the user picks it or has opted in for that account. There
is none when the settings allow no Tenjin route for the task. A lead this
machine cannot run (connecting found the account lacks its tool, or there is
no sign-in here) is never shown: the client offers the fallback in its place,
with a line of its own, under the checks any paid offer meets.

An account call's outcome report keeps a broken map apart from an account
that refused: a refusal (sign-in, plan or rate limit) is `unpaid` with
`reason: "provider"`, a result that misses `resultSchema` is `unverified`, and
a poll that reaches `failed` is `failed`.

### Connecting

The directory request's `accepts` is read for `mcp` alone. With it, the full
answer adds every account to `sources`, their services to `services`, the
providers and sellers only those name, and `connectable`: every account a
client can connect, which between them list every service not on `tenjin`.
Without it the answer is the one a client that cannot run them always got.
Each connectable account is `{id, label, mcpUrl, signIn, key?, services}`:

- `id`: the account's source id, under which the client keeps its credential:
  1 to 48 of `[a-z0-9-]`, starting with a letter or digit, never `tenjin`.
- `mcpUrl`: its MCP server, https with no credentials, query or fragment.
- `signIn`: `oauth` (MCP sign-in), `key`, or both. With `key`, `key: {scheme}`
  says how a pasted key is sent, `Authorization: <scheme> <key>`: `Bearer`
  for Apify and Firecrawl, `Key` for fal, whose key is `<key_id>:<key_secret>`.
- `services`: `{id, verified, useFirst, tools}` for each mapped service.
  `useFirst` says whether the account-wide preference puts it first, so the
  connect readback can name the jobs the account is used first for; a catalog
  edit sets it false to demote a service without removing it. `tools` lists
  each call its spec makes (the call, the poll, the follow-up), each with the
  top-level `arguments` it sends. A connect-time `tools/list` that lacks one
  leaves that service out on this machine.

`revision` is the ETag of the answer the client gets, so an `mcp` client's
covers `connectable`.

tenjin-cli signs in with Tenjin's OAuth client document, which is its alone,
`oauth-client-metadata.json`, served at its own `client_id`,
`https://tenjin.sh/oauth/client-metadata.json`.
It is a public client: no secret, `token_endpoint_auth_method: "none"`, PKCE,
`authorization_code` and `refresh_token`. Its `redirect_uris` are fixed
loopback ports, `http://127.0.0.1:<port>/callback`, which `tenjin connect`
serves for one sign-in. A server that still wants dynamic registration gets the
same fields. No token or code reaches Tenjin's server.

### Refusals on an account

Both come as `native` with `policy_refused` and the `rule`:

- `unavailable`, `{from: "saved", target: {kind: "source", id}}`: a route on
  an account that `sources` does not list. "Apify isn't connected on this
  machine." The router offers no such route, so a client meets it rechecking a
  saved offer.
- `unverified`, `{from: "request", target: {kind: "service", id}}`: the rules
  allow some service for the step, but every one they allow is an account
  service Tenjin hasn't checked and the request doesn't name. It names the
  first: "Tenjin hasn't checked fal FLUX1.1 Pro Ultra yet, so it runs only
  when you ask for it by name." When the rules leave nothing checked for any
  step, the refusal made before the gate names the rule instead, which holds
  whatever was asked: "Your Tenjin settings block Tenjin's tools." A client
  refusing, unnamed, a tool of a connected account that has no map uses the
  same rule on the account's `source`: "Tenjin hasn't checked your <label>
  account yet, so it runs only when you ask for it by name."

Text a user reads names an account by its label, never its id. The maps ship
unchecked (catalog `fixtures/catalog/sources`, with no `verifiedAt`). The
account fixtures are the live route's answers with Apify's Google Maps map
marked checked, as a real call will mark it, and, in the directory, Firecrawl's
search kept out of the account-wide preference (`useFirst: false`), as a
catalog edit would demote it; their Actor, model, tool and argument values
stand in until those checks settle them.

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
`returns`, `returnsExample`, `resultSchema` and `outputSchema`. `outputSchema`
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
| `wire-hook-request-policy.json`            | the hook before a search, from a client that sends `identity` and `bound`, with `policy`  |
| `wire-tool-request-policy.json`            | the tool call with `policy` and an `override`                                             |
| `wire-browse-request-policy.json`          | a browse with `policy`                                                                    |
| `wire-tool-request-by-id-policy.json`      | a row's id with a `policy` that blocks the `tenjin` source                                |
| `wire-hook-execute-identity.json`          | hook answer for it: `identity` on the answer and its spec, `bound` from the search        |
| `wire-hook-execute-augment-identity.json`  | the free docs augment with its `identity`, and no `bound`                                 |
| `wire-hook-discovered-bound.json`          | a list offer before a search: each spec's `identity`, and `bound` for the lead's          |
| `wire-lookup-spec-identity.json`           | a row's spec with its `identity`                                                          |
| `wire-hook-policy-refused.json`            | hook answer when the settings allow no service: `policy_refused` and its `rule`           |
| `wire-lookup-policy-refused.json`          | tool answer for the blocked row's id: `policy_refused`, no gate call                      |
| `wire-directory-request.json`              | the directory, with the revision the client holds                                         |
| `wire-directory.json`                      | the directory answer, trimmed to the services the other fixtures name                     |
| `wire-directory-unchanged.json`            | the directory answer for the revision the client already holds                            |
| `wire-policy-cases.json`                   | `allowed` cases: `[{name, policy?, override?, identity, expect}]`, run by both sides      |
| `wire-hook-request-mcp.json`               | the hook from an `mcp` client: its accounts in `sources`, Apify preferred                 |
| `wire-hook-execute-account.json`           | hook answer: a checked account lead alone, no `endpoint`, and the `fallback`              |
| `wire-tool-request-account.json`           | the tool call naming the user's fal account: `override.prefer` its source                 |
| `wire-lookup-spec-account.json`            | tool answer: an unchecked account spec, its `when` follow-up, and the `fallback`          |
| `wire-tool-request-only-accounts.json`     | the tool call with Tenjin's own tools blocked, naming no account                          |
| `wire-lookup-account-unverified.json`      | tool answer for it: `policy_refused` with the `unverified` rule                           |
| `wire-directory-request-mcp.json`          | the directory from an `mcp` client                                                        |
| `wire-directory-mcp.json`                  | its answer: `connectable`, trimmed to the account fixtures' services, one not `useFirst`  |
| `oauth-client-metadata.json`               | Tenjin's OAuth client document, served at its `client_id` (Connecting, above)             |

Two rules the fixtures exist to hold:

- **In an offer, the line and its `specs` name the same ids.** A caller cannot
  approve one service and run another. A compare choice's line names the
  decision's id and `choices` names the rest, each with its spec.
- **Every non-execute answer carries `diagnostics`, nested inside `decision`.**
  That is the intended shape: they sit on the union's non-execute arms so a
  contractless outcome without diagnostics does not typecheck.

There is no `billing` block and no fee. The decision is free; the one payment in
a lookup is the caller's own, to the provider, or the user's own plan on a
connected account.

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
| `accepts`                       | up to 16 strings, 1-32 characters, `spec` required; the server also reads `catalog`, `label`, `fields`, `jobs`, `identity`, `bound`, `mcp`, `discovered` (the list), `bazaar` (Bazaar), `choices` (compare) |
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
| `policy`                        | `version` exactly `1`; 16384 bytes serialized; `sources` 1 to 16; `block` 1 to 128 targets; `only` 1 to 32 entries of 1 to 64 targets; `prefer` 1 to 64 entries of 1 to 16 targets                          |
| `override`                      | `only` 1 to 4 entries of 1 to 16 targets; `prefer` 1 to 16 targets; at least one of the two; only beside `query`                                                                                            |
| target `id`, source id          | 1 to 64 characters: a letter or digit, then letters, digits, space, `.`, `_`, `:` and `-`                                                                                                                   |
| `revision`, `ifRevision`        | 16 lowercase hex characters                                                                                                                                                                                 |
| `identity`                      | `providers` and `categories` up to 8 ids each                                                                                                                                                               |
| `bound`                         | a JSON object, at most 16384 bytes serialized, like `input`                                                                                                                                                 |
| `directory` lists               | `categories` 64, each 1 to 64 `tasks`; `tasks` 256; `providers` and `sellers` 512 each; `sources` 64; `services` 1024; `retired` 512; every `label` 1 to 120 characters                                     |
| account `mcp`                   | `tool` 1 to 128 of `[A-Za-z0-9_.-]`, not starting with `.` or `-`; the call, `next` included, 8192 bytes serialized; a `{result.<path>}` path up to 4 names                                                 |
| `next.poll`                     | `everyS` 1 to 30, `maxWaitS` 1 to 600; `when`, `running` and `failed` each 1 to 8 `values` of 1 to 64 characters                                                                                            |
| `connectable`                   | 16 accounts; `id` 1 to 48 of `[a-z0-9-]`, starting with a letter or digit; `mcpUrl` up to 2048 characters; 1 to 64 `services`, each 1 to 3 `tools` of up to 32 `arguments`                                  |
| `diagnostics.missing`           | 60 entries, each non-empty                                                                                                                                                                                  |
| `id`                            | a uuid the server minted; a client never invents one                                                                                                                                                        |
| id lifetime                     | 15 minutes from the hook call that created it                                                                                                                                                               |

Expired packets are unreadable after 15 minutes (the route refuses an expired id) and are deleted by the next router request or the daily cleanup, whichever comes first; a discovery run's search text (built from the user's words) is cleared at the same expiry.

The enumerated values live in code: the task ids and categories in
`fixtures/catalog/tasks.json`, the provider, seller and retired ids in
`fixtures/catalog/services.json`, `DIAGNOSTIC_CODES` and `DIAGNOSTIC_STAGES` in
`diagnostics.ts`, `TARGET_KINDS` and `ONLY_DIMENSIONS` in `wire.ts`.
`docs/ENVIRONMENTS.md` covers the kill switch and the rate limits.
