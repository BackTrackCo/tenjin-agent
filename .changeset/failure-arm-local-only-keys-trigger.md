---
'tenjin-cli': minor
---

The failure arm answers from this machine's own record and never searches the error text; every search names its arm; `publish --key` (tenjin-agent#212, PR A).

**The failure arm no longer sends the error tail anywhere.** The fuzzy `/api/search` leg it ran on a failing build, test, migration, install or lint command is gone: on two machines every hit it produced was an unrelated note at `confidence: low`, and the tail it sent is the string in the sidecar most likely to carry a credential or a path. The arm now normalizes the error into a signature, replays the fix this machine already recorded for it (a local pairing), or opens a pairing for the next pass on the same head to close, and exits. A failure with no local pairing is silent and writes no decision row. The team shelf by fingerprint (two hashes on the wire, `POST /api/keys/resolve`) follows in the next release.

**The allowlist is fixed.** `git` is no longer a head the arm fires behind: every pairing on record had been opened by `git show … | grep ENOENT` over source that merely mentions an errno. `node`, `deno`, `python` and `python3` count only when their first argument is a file, so `python3 -c`, `node -e` and a piped stdin never do. A pairing is never opened when the error named no file in the repo, or only `<string>`/`<stdin>`: nothing a later edit touches could ever close it.

**Every search names the arm that fired it.** `trigger` rides on each `/api/search` body — `cli` from `tenjin search` and the MCP tool, the hook's own name (`research`, `dispatch`, `prompt`, `read`, `churn`) from a hook — so the shelf's per-trigger use rates (`GET /api/lookups/stats`) stop reading as one `cli` bucket. Telemetry only; a shelf that predates the field records `cli`.

**`tenjin publish --key <kind=value>`** (repeatable, up to 32; the MCP publish tool's `key`) sends exact-match keys on the post body — `fingerprint`, `package_version`, `command_head`, `repo` — bounded before the wallet signs. Keys go out unverified; `verified` belongs to the close rule. A shelf with `KNOWLEDGE_KEYS` off refuses a keyed body as `keys_disabled`, and a verified key another published piece holds comes back as "`<kind> <key>` is already verified on `<id>`; publish it unverified"; neither is retried.

**The store records what the importance score will need.** One `events` row per prompt (including the short and slash ones nothing is asked about), per Edit/Write (the basename), per failure (the signature as `error_hash`, the scrubbed line), and per pass behind an allowlisted head. `tenjin push status` gains a pairings line: opened, closed, verified, the closed rows' scope, and the heads that opened them.
