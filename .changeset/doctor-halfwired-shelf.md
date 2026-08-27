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

And `fetchJson` now reports whether the response looked like an access gate (an
HTML content-type, or a followed redirect that landed on another host, reported
separately because only the second proves a sign-in redirect), on the 2xx that
failed to parse and on a 401/403, because the transport is the only place
holding the response. All three baseUrl probes read that signal and say a page
answered instead of the API, claiming no more than the signal proves. They point
at `shelfBypassSecret` only on a machine where that key is a remedy, a
configured (`file`) base URL on a shelf of the team's own, and the wording
follows what the probe did: with no secret configured the fix is to set it, and
when the key was sent and still did not get past (a gate page, a 401/403, or the
blocked redirect interstitial a rotated key gets) the fix is to update the stale
key. A blocked redirect counts only when its `Location` leaves the host asked
for: a same-host 3xx is what an `http://` base URL or a non-canonical host name
gets with a perfectly good key, so that one says the URL redirects and to point
`baseUrl` at the host it lands on. Against the public marketplace the key is refused anyway, and against an
override the origin belongs to that one run, so both get a line about a proxy or
a sign-in wall and no credential to write. No check output carries the secret's
value, only the key's name.
