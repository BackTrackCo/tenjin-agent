---
'tenjin-cli': patch
---

Move the spend ledger to its own file, and tell you when an update is out.

The client-side rolling spend ledger was written to `~/.tenjin/session.json` —
the same file the P-256 session key is cached in. Two incompatible schemas in one
path, and each reader treats a parse failure as "no file", so the two silently
destroyed each other: minting a session key zeroed the 24h spending window, and
the next purchase deleted the session key it had just been asked to keep. The
ledger now lives in `~/.tenjin/spend.json` and the two never meet.

An unreadable ledger still fails open — a local cache must not block a spend —
but it no longer does so in silence. When the file exists and cannot be parsed,
one dim stderr line at a human terminal names the path, the reason, and the
consequence: the spending window restarted.

New: at most once every 24 hours, at a human terminal, the CLI checks npm for a
newer `tenjin-cli` and prints one dim line saying so. It is skipped entirely off
a TTY, under `--json`, and when `CI` is set, so no agent or build ever sees it;
it runs after the command's own output, times out at 1.5s, and swallows every
failure, so it cannot change what a command prints or what it exits with.
