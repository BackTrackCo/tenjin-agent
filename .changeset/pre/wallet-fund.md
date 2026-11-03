---
'tenjin-cli': minor
---

BREAKING: `tenjin fund` is now `tenjin wallet fund`.

Funding operates on the wallet and nothing else, so the verb moves under the
wallet group beside `wallet show` and `wallet balance`: one uniform group in
`--help`, in the skill, and in the permission allowlist, where the free-tier
rule is now `Bash(tenjin wallet fund:*)`. Update any allowlist carrying the old
`Bash(tenjin fund:*)` line; there is no compat alias, the same clean-break
posture as the candidate-pen removal. The behavior, flags, and output are
unchanged, and the MCP tool keeps its flat `tenjin_fund` name: MCP names do not
nest, and renaming the tool would break MCP consumers for no grouping gain.
