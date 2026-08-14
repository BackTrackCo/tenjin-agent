---
'tenjin-cli': minor
---

Let `TENJIN_FUND_ORIGIN` move the origin `tenjin fund` mints against. The hard
pin shipped with the command made a domain migration, or a run against a preview
deployment, need a code release; the env var is the one override that is safe to
keep, because an env-prefixed invocation
(`TENJIN_FUND_ORIGIN=https://... tenjin fund`) does not match the
`Bash(tenjin fund:*)` allowlist prefix, so an allowlisted agent cannot exercise
it. `--base-url` and config stay cut for the mirror-image reason: both ride
inside that prefix. The value is normalized to a bare `scheme://host[:port]` so
the request URL and the SIWX domain cannot desync, a value that is not an
absolute http(s) URL is a `USAGE` refusal before anything is signed, and any run
not against production announces the origin on stderr. Unset, the origin is
`https://tenjin.blog` exactly as before.
