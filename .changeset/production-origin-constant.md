---
'tenjin-cli': patch
---

Read the production Tenjin origin from one constant, `PRODUCTION_ORIGIN` in
`src/lib/production-origin.ts`.

The shipped `baseUrl` default, the generated WebSearch hook's fallback, the
`User-Agent` comment, the pinned `fund` origin, the `config set` URL hint, the
install hook copy, and the hosted-skill replacement warning all derived their own
copy of `https://tenjin.blog`. They now import it, so moving the CLI to a new
origin is one edit and a release rather than a sweep that can half-apply.

No behavior changes: every string those call sites emit is byte-identical, the
generated hook scripts hash the same (so `HOOK_SCRIPT_VERSION` does not move and
no installed hook is rewritten), and dual-serve semantics are untouched.
`fund` keeps its hardcoded production origin with no override surface.

`production-origin.test.ts` is the anti-half-flip guard: it pins each of those
modules to the constant and fails on any non-comment line under `src/` that
spells the host out.
