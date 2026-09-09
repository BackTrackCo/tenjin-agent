# A diff whose two sides read the same is a character you cannot see: dump code points before changing the code

When a string comparison here fails and the expected and received values read identically on screen, nothing further you read will separate them. The runner prints those characters raw, so two different space characters both print as one blank, and re-reading the source, the test, or the diff yields nothing. Ask the runtime instead:

    [...value].map((c) => c.codePointAt(0).toString(16))

The expected values in this project are `Intl` output on this runtime, and its ICU emits U+00A0, a no-break space, as the group separator, not the U+0020 you would type by hand. That is a dated fact rather than an eternal one: ICU 72 moved several locales to U+202F, and on this runtime `fr-FR` groups with U+202F while `sv-SE` and `ru-RU` still group with U+00A0.

So build the string through `Intl` for the `sv-SE` locale, or write the separator as an explicit escape. Which cases run, and what each one expects, still come only from a run.
