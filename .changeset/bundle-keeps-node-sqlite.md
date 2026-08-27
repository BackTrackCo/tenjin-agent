---
'tenjin-cli': patch
---

The CLI can read its own state store again. esbuild does not know `sqlite` as a Node builtin and rewrote every CLI-side `import('node:sqlite')` to a bare `sqlite`, so `tenjin push status` reported an empty store, `tenjin doctor` said `node:sqlite` was unavailable, and the one-time ledger import never ran — while the generated hook scripts (string templates the bundler never sees) wrote to that same `state.db` the whole time. The CLI now resolves the module through `process.getBuiltinModule`, which a bundler cannot touch, and the build fails on any bare `sqlite` specifier in `dist/`.
