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
The `api-contract` check reads that flag and swaps its fix line to
`shelfBypassSecret` when it is set. No check output carries the secret's value,
only the key's name.
