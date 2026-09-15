---
'tenjin-cli': minor
---

The failure arm fires behind a fixed allowlist of command heads; every search names its arm; `publish --key` (tenjin-agent#212, PR A).

**The allowlist is fixed.** `git` is no longer a head the arm fires behind: every record it opened had come from `git show … | grep ENOENT` over source that merely mentions an errno. `node`, `deno`, `python` and `python3` count only when their first argument is a file or their own test runner (`node --test`, `deno test`), so `python3 -c`, `node -e` and a piped stdin never do; `python3 -m pytest` and `python -m unittest` are read as `pytest` and `unittest`, the module being the program.

**`tenjin search` names itself too.** The hook arms already send `trigger` on each `/api/search` body; this release adds the manual half, so `tenjin search` and the MCP `search` tool over it send `cli` explicitly rather than relying on the server's default. The arms that send one are `research`, `dispatch`, `prompt` and `failure`. Telemetry only; a shelf that predates the field records `cli`.

**`tenjin publish --key <kind=value>`** (repeatable, up to 32; the MCP publish tool's `key`) sends exact-match keys on the post body — `fingerprint`, `package_version`, `command_head`, `repo` — bounded before the wallet signs. Keys go out unverified; `verified` is the shelf's own claim about a key. A shelf with `KNOWLEDGE_KEYS` off refuses a keyed body as `keys_disabled`, and a verified key another published piece holds comes back as "`<kind> <key>` is already verified on `<id>`; publish it unverified"; neither is retried.
