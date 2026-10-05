---
'tenjin-cli': patch
---

Read the production Tenjin origin from one constant, `PRODUCTION_ORIGIN` in
`src/lib/production-origin.ts`.

The shipped `baseUrl` default, the generated WebSearch hook's fallback, the
`User-Agent` comment, the pinned `fund` origin, the `config set` URL hint, the
install hook copy, and the hosted-skill replacement warning all derived their own
copy of `https://tenjin.blog`. They now import it, so no shipped string can be
left behind by a partly-applied sweep.

The cutover is not a single edit. Shipped code reads the constant, but three
places deliberately do not: `fund.test.ts` and `client-meta.test.ts` each keep
their own written-out copy, so re-pointing the wallet-signed `fund` mint or the
`User-Agent` costs two files in one PR, and `package.json`'s `homepage` is JSON
that cannot import. All three are pinned, so the flip commit reds until each is
edited on purpose.

No behavior changes: every string those call sites emit is byte-identical, the
generated hook scripts hash the same (so `HOOK_SCRIPT_VERSION` does not move and
no installed hook is rewritten), and dual-serve semantics are untouched.
`fund` keeps its hardcoded production origin with no override surface.

`production-origin.test.ts` is the anti-half-flip guard: it pins each of those
modules to the constant, pins the two skill-mirror scripts (which run outside the
bundle and cannot import it) to the same origin, and sweeps `src/` for any
non-comment line that spells the host out. The sweep is advisory, an
honest-mistake catcher rather than a boundary: it reads raw lines, so a host
assembled at runtime walks past it.
