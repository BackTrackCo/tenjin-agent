---
'tenjin-cli': patch
---

fix(build): keep the `node:` prefix on `import('node:sqlite')` in the bundle. tsup's default `removeNodeProtocol` shipped it as `import('sqlite')`, so `tenjin doctor` reported the state store missing and the CLI-side store (`push status`, search recording, publish dedup) failed open on every Node; the generated hooks were unaffected. The packed-artifact smoke now pins the specifier.
