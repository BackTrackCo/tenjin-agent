---
'tenjin-cli': patch
---

`tenjin doctor` names the half-wired team shelf instead of blaming the base URL.

A machine with `baseUrl` on a team deployment and no `shelfBypassSecret` used to
emit no `team shelf` check at all, and every probe ran unauthenticated. On a
protected deployment the probes were answered by the hosting platform's
protection page, so doctor reported `CONTRACT_MISMATCH: OpenAPI document was not
valid JSON` and told the operator to point `baseUrl` at a Tenjin API, which is
the one setting that was already correct.

Two changes. `checkTeamShelf` now warns on that half too, from the settings
alone, so it is reported before the network says anything and on a deployment
that is not protected yet. It fires only on a `baseUrl` that came from config: a
`--base-url` or `TENJIN_BASE_URL` override is this run's choice, and the existing
withheld-key warn already names an override. Empty secret plus the public
marketplace stays silent.

And `fetchJson` now reports whether the 2xx that failed to parse looked like an
access gate — an HTML content-type, or a followed redirect that landed on
another host — because the transport is the only place holding the response.
The `api-contract` check reads that flag and says a page answered instead of the
API. It points at `shelfBypassSecret` only on a machine where that key is a
remedy: a configured base URL on a shelf of the team's own. Against the public
marketplace the key is refused anyway, and against an override the origin
belongs to that one run, so both get a line about a proxy or a sign-in wall and
no credential to write. No check output carries the secret's value, only the
key's name.
