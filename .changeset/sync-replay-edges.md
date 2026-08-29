---
'tenjin-cli': minor
---

Close three sync/replay edge cases the team shelf carried since automatic sync
shipped (tenjin-agent#249).

**The coarse key is salted with the repo, not the remote url.** The team-shelf
coarse fingerprint used the raw `origin` url as its salt, so one repo had four
salts — `git@host:acme/api.git`, `https://host/acme/api`, the same with `.git`,
and `ssh://git@host:2222/acme/api` are one project, and two teammates who
cloned it over different transports could never match each other's coarse keys.
A url can also carry a credential in its userinfo, which the salt hashed rather
than dropped. The salt is now `host/full/path`, lowercased, with the scheme,
the userinfo, the port, a `.git` suffix and trailing slashes dropped — so the
transports of one repo collapse and nothing else does. A fork, a mirror of one
repo on another host, and two namespaces that merely end alike all stay on
separate salts. One known limit, documented rather than special-cased: Azure
DevOps spells one repo `https://dev.azure.com/org/proj/_git/api` over https and
`git@ssh.dev.azure.com:v3/org/proj/api` over ssh, so an Azure team matches
coarse keys only within a transport.

**A checkout with no git `origin` is local only.** It has no repo scope to salt
with, and the empty string that stands in for one is not a salt: publishing and
querying under it would pool every origin-less checkout on a team's shelf into
one coarse bucket, and a coarse key hit is rank 1 with no relevance check to
run. So the failure arm asks the shelf nothing there (recorded as `no-remote`,
spending no lookup), `tenjin sync` publishes nothing and stamps nothing, and
the Stop hook does not spawn a sync at all. Local pairings replay exactly as
before; if the checkout later gains an origin, the next run publishes its rows.

**Note for existing team shelves:** coarse keys already published under the old
url salt are simply not republished. Nothing resets `synced_at`, so no bulk
re-sync runs and none is offered. There is a partial recovery path, though, and
it is automatic: a row whose pairing is later promoted to `verified` is picked
up again on `closed_at > synced_at` and PUT back, and the PUT carries freshly
computed keys — so that row's coarse key IS rewritten under the new salt. Rows
that never change again keep their old key, which keeps working for anyone
still salting the old way and matches nothing after this release. Fine fingerprints are unaffected — they carry no salt, and they are
what has been doing the matching.

**A stale sync claim is taken over in one statement.** The Stop hook runs one
`tenjin sync` per machine behind a claim that expires by age; taking an expired
claim over was a clear followed by a claim, and two Stops that both read it as
stale both cleared and both spawned a detached child. It is now a single
conditional update, so exactly one wins. The free-claim end of the same
arbitration is fail-closed too: a store that swallows the insert is a loss, not
a win, so a read-only store cannot let every Stop spawn.

**`tenjin sync` takes `--cwd <path>`**, and the Stop hook passes the hook
payload's cwd through it. Pairing rows are scoped by a hash of the cwd string
the payload carried, while `process.cwd()` in the spawned child is that path
with symlinks resolved — so a session under a symlinked checkout had the hook
counting rows the sync it spawned could not see, and every run reported
"Nothing to sync." An empty `--cwd` is a usage error rather than a silent
fallback to the working directory.
