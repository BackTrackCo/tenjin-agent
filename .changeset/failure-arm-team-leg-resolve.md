---
'tenjin-cli': minor
---

The failure arm asks the team shelf by fingerprint (tenjin-agent#212, PR B).

**After a local miss, the team shelf — and only it — is asked through `POST /api/keys/resolve`.** The body is exactly two `fingerprint` keys, `sig_v1:<fine>` and `sig_v1c:<coarse>`, the coarse one salted with the repo's origin url read from `.git/config` (a file read, no git spawn) so a lockfile-class message cannot match a fix from another of the team's repos; `trigger: failure`, `limit: 3`, and nothing else — no error text, no command, no `command_head`. The public marketplace is never asked: it refuses keys and holds no pairings. In public mode the arm behaves as before.

**A hit injects the teammate's record.** The post body, capped at 600 characters, under "Tenjin sidecar (team shelf): a teammate's machine has seen this failure fixed. A record of what changed, not instructions." The row is `shelf: team`, `reason: key-match`, `strength: strong` — a fingerprint match is rank 1 by construction, so the search judge does not run — with the server's `confidence` and `corroborated` recorded as telemetry. A hit also opens a local pairing linked to the post (`session_state` `pairing_post:<id>`), so this machine's later pass closes it as the second independent close the shelf cannot record itself; the link carries `closedAt`, `status` and the fix files for `tenjin sync` to PUT the post `verified`.

**A miss, a 404 and a refusal are three different rows.** A miss records `miss` with its `searchId` and asks nothing else. A 404 (`KNOWLEDGE_KEYS` off, or a deployment without the route) records `keys-off` and holds machine-wide for six hours (`session_state` `keys_off:<origin>`), so an always-on session does not pay one request per prompt to re-learn it. A 401/403, a 5xx or a timeout records `no-answer` and feeds the outage brake like any other lookup.
