---
'tenjin-cli': patch
---

fix(inspect): `inspect`/`read`/`buy` now resolve a bare id that no local search or `tenjin sync` pairing knows about — the id `tenjin publish` itself just printed — through the public `GET /api/posts/<id>/public` route (tenjin#803), instead of refusing with `RESOURCE_NOT_FOUND` until a `tenjin search` happened to surface it first. The by-id response's own `id` is checked against the id that was asked for, and its `slug`/`creator.handle` are constrained to a single safe path segment, before either is trusted to build the payable read URL.
