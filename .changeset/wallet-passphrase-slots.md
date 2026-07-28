---
'tenjin-cli': patch
---

Fix a funds-loss bug: `tenjin wallet create` no longer overwrites the machine's
single OS-store passphrase slot. Every wallet passphrase now lives in its own
per-wallet entry (service `tenjin-cli`, account = the wallet address; on Windows
a per-wallet `passphrase.<address>.dpapi` blob), the `-U` update-in-place write
is gone, and a create verifies its stored passphrase reads back before
encrypting. Existing single-slot installs migrate on the first signing that
proves ownership: the legacy entry is copied under the owning wallet's address,
the copy is verified, and only then is the legacy slot removed; when the legacy
passphrase does not decrypt the active wallet, the entry is left untouched and
the ambiguity is surfaced. The `WALLET_EXISTS` error now names the real risk —
the unrecoverable passphrase entry in the OS credential store, not just the
keystore file.
