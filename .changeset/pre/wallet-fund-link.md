---
'tenjin-cli': patch
---

`tenjin wallet fund` asks the server for the checkout link for your region. In the US the link opens a Tenjin page that takes Apple Pay or Google Pay with no Coinbase account. Elsewhere it is still the hosted Coinbase checkout. The CLI opens only `tenjin.sh` and `pay.coinbase.com` links.
