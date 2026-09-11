# Fixture repository

`fill(template, values)` fills a template's named slots. A slot is a name in braces, a name may appear in the template more than once, and a slot whose name the values do not carry is left as it stands.
Run one test file with `pnpm test -- tests/<name>.test.mjs`; the cases it runs come from the runner, so a run is the only place to read them.
