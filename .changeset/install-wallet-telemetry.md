---
'tenjin-cli': patch
---

Requests to Tenjin now carry `X-Tenjin-Install`, an anonymous random id minted
once in the data dir (`~/.tenjin/install-id`), and, when a wallet exists,
`X-Tenjin-Wallet`, its public address, read without the passphrase. Tenjin uses
them to count router users. Neither header is sent to a provider or to a team
shelf, and a file that cannot be read only drops its header.
