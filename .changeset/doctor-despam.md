---
'tenjin-cli': patch
---

`tenjin doctor` is a check list again. The ~60-line permission essay it printed
above its own results is now one closing link to `docs/agent-permissions.md`,
which already carried the same material: the nine free-verb rules, both opt-in
notes, the excluded verbs, the `--base-url` caveat and the MCP tool note. Nothing
was deleted and `doctor --json` is unchanged, so an agent still reads the whole
recommendation as data under `permissions`. `tenjin install` points at the same
page, in its permission question and in the line reporting a write.

The `wallet` check now proves the keystore opens instead of only proving it
parses. When the passphrase is reachable without a prompt (`TENJIN_WALLET_PASSPHRASE`
or the OS credential store) doctor decrypts and checks the recovered key against
the stored address; when it is not, the wallet is reported present but not
verified rather than ok. It never prompts and never writes, so the legacy-slot
re-key still belongs to the first real signing. A wallet whose passphrase is gone
used to read `wallet: ok` until a purchase or a publish failed.

`tenjin install` reads as what happened, then what still needs you: the summary
comes first and any attention items follow it. Its embedded doctor snapshot is
taken after all three setup decisions, so a run that creates a wallet no longer
reports `No wallet` in the walkthrough and in `--json`. With no wallet at all the
summary's own line is the only place that is said.
