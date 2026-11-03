---
'tenjin-cli': patch
---

Treat the deployment's known origins as one deployment, so the `tenjin.sh`
cutover (tenjin#402) does not break an installed CLI.

The server builds search candidate URLs from its own global, not from the request
host, so the moment that global flips, every candidate arrives on the new origin
while a configured `baseUrl` still names the old one. `assertOnBaseOrigin` then
refused the whole response with `CONTRACT_MISMATCH`, taking `search`, `read`,
`buy`, and `inspect` down together. `src/lib/production-origin.ts` now carries
the deployment's origin set and `isSameDeployment`, which `assertOnBaseOrigin`,
the `pay` lane, and the generated WebSearch hook all consult.

The check is not loosened. Aliasing applies only when the configured base is
itself one of the deployment's origins: a self-hosted, preview, or localhost
`baseUrl` keeps the exact comparison it has today, a differing scheme or port is
still a different origin, and any origin outside the set is refused with the same
code, the same message, and the same fix line, which still never coaches
re-pointing the CLI at the URL that just failed.

`PRODUCTION_ORIGIN` does not move here; the shipped default flips in a later
release. Stored config is not rewritten, so nothing an operator set is touched.
`HOOK_SCRIPT_VERSION` moves to 19 because the generated hook body changed; the
installer rewrites hooks on the next `tenjin install`.
