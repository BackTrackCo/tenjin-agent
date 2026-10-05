---
'tenjin-cli': minor
---

A request spec can now name the fields its result promises (`outputSchema`).
The `request` tool checks the success rule on the provider's whole body as
before, then hands the agent only the fields the spec declares, through
nested objects and array items, and saves the whole body under
`~/.tenjin/results/` (mode 0600, kept a day) at the path the result names in
`fullResultPath`. An Apollo person lookup, whose body carries the employer's
whole organization record, comes back as the person's name, title, email,
LinkedIn URL, employer and work history. A body that cannot be cut (not JSON,
over the 4 MB result cap) or a file that cannot be written hands back the
whole body, as before; the projection never fails a call. A spec with no
`outputSchema` returns the body unchanged.
