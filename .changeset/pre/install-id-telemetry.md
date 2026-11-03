---
'tenjin-cli': patch
---

Requests to Tenjin now carry a `tenjin-install-id` header: a random, anonymous
id minted once and stored at `~/.tenjin/install-id`. It is sent only to Tenjin,
never to a provider or a team shelf, and Tenjin uses it to count installs and
router usage. A file that cannot be read or written only drops the header.
