---
'tenjin-cli': minor
---

Close three sync/replay edge cases the team shelf carried since automatic sync
shipped (tenjin-agent#249).

**The coarse key is salted with `owner/name`, and both sides always send it.**
The team-shelf coarse fingerprint used the raw `origin` url as its salt, so one
repo had four salts — `git@host:acme/api.git`, `https://host/acme/api`, the
same with `.git`, and `ssh://git@host:2222/acme/api` are one project, and two
teammates who cloned it over different transports could never match each
other's coarse keys. A url can also carry a credential in its userinfo, which
the salt hashed rather than dropped. The salt is now the last two path segments
of the remote, lowercased, and `''` for anything that is not a remote. Separately,
`tenjin sync` used to publish no coarse key at all in a checkout with no
`origin` while the failure arm went on asking for one under the `''` salt, so
those pairings could only ever match on the fine key; both sides now send it.

**Note for existing team shelves:** coarse keys already published under the url
salt will not match the new one. The fine fingerprint is unaffected and is what
has been doing the matching, so the practical loss is nil — but a shelf with
coarse-key hits worth keeping should re-sync the machines that published them.

**A stale sync claim is taken over in one statement.** The Stop hook runs one
`tenjin sync` per machine behind a claim that expires by age; taking an expired
claim over was a clear followed by a claim, and two Stops that both read it as
stale both cleared and both spawned a detached child. It is now a single
conditional update, so exactly one wins.

**`tenjin sync` takes `--cwd <path>`**, and the Stop hook passes the hook
payload's cwd through it. Pairing rows are scoped by a hash of the cwd string
the payload carried, while `process.cwd()` in the spawned child is that path
with symlinks resolved — so a session under a symlinked checkout had the hook
counting rows the sync it spawned could not see, and every run reported
"Nothing to sync."
