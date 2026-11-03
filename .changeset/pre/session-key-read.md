---
'tenjin-cli': minor
---

Restore owned-library recovery to `tenjin read`, on a session key that cannot pay.

New verb: `tenjin session start --scope read` opens the wallet ONCE and mints a
≤24h P-256 session key (cached 0600, address-bound, origin-bound, server-clamped). It is
idempotent — a live session wide enough for the scope is reused and the wallet is
never opened again, so a cached `read+write` session left by `publish`/`edit`
serves a read run rather than being downgraded. v1 mints `read` and nothing else:
any other `--scope` is refused as a usage error, which is what makes the
allowlist rule for it non-escalatable. Output is address, scope, and expiry only,
never the delegation or the key.

`tenjin read` now uses it. On a cold 402 for a piece that is not in the local
library, if a read-scoped session key is already cached, `read` presents it on
exactly ONE bodyless signed GET (RFC 9421, no `Content-Digest`, so nothing claims
to cover bytes the request never sends). A 200 means this wallet already owns the
piece and it is delivered free. There is no second attempt and no recovery: an
unusable file, a second 402, or a rejected delegation all fall to the ordinary
exit-3 refusal. Its `details.entitlementCheck` reports what the server actually
said: `'session'` (a live delegation was presented and the server answered "you do
not own this" — the only state where buying is the answer), `'not_performed'` (no
usable key), `'session_rejected'` (the delegation was declined), or
`'session_inconclusive'` (the check never completed). The last three keep
`sessionCommand` in the payload so an agent re-mints instead of spending on a
piece it may already own. `read` still cannot pay and cannot open a keystore.

That last claim is structural, not a promise. `lib/session-key` was split: the
present-only half (`lib/session-present` — load a file, sign one request) is what
`read` imports, while minting a delegation stays in `lib/session-key`, which
`read`'s test-pinned import graph still bans along with `lib/wallet` and
`lib/x402-pay`. So the key `read` can hold is P-256 — the wrong curve for the
EIP-712/secp256k1 signature an EIP-3009 transfer authorization needs.

The session file is a wallet-derived credential and is treated as one. It records
the ORIGIN it was minted against and is never presented anywhere else, which is
what stops `tenjin read <url> --base-url <host>` — one command line the always-safe
`Bash(tenjin read:*)` rule already clears — from handing the delegation to a host
an agent picked; the same binding makes a stale file survive a base-URL switch by
failing closed instead of presenting something unverifiable. Its documented bounds
are that origin, the 24h expiry, and the 0600 mode. The `read` scope is NOT
offered as one of them anywhere in the shipped copy: scope is enforced only on the
request shape that carries a session signature alongside the delegation header, so
it does not bound what a copied file is worth.

Permission tiers: `Bash(tenjin session start:*)` joins `Bash(tenjin buy:*)` as an
explicit opt-in (it spends nothing and cannot, but it does open the keystore). The
`read` entry and `FLAG_CAVEAT` now disclose that `read` transmits a wallet-derived
credential off-machine once a session exists, rather than scoping signed traffic to
the paying verb.
The always-safe tier's definition is sharpened everywhere it is stated — skill,
README, `doctor`/`install` block, module docs — from "no wallet, no signing, no
payment" to **cannot spend and cannot open the keystore**, because `read` now
signs and the old wording had become false. `tenjin doctor` gains a `session`
check reporting whether a key exists, for which origin, at what scope, and when it
expires. Absent is `ok`, not a warning; expired, origin-drifted, corrupt, loosened
past 0600, or unreadable all warn and none of them fail the run — including the
unreadable case, which previously threw out of the check list and took down the
whole diagnostic.
