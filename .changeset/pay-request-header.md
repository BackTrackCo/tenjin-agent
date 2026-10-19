---
'tenjin-cli': minor
---

`tenjin pay` can read a paid endpoint before it pays one, and the plugin now
teaches an agent to do both with this machine's wallet.

`tenjin pay <url> --quote` decodes the 402 and reports every payment option
with its amount in USD, the resource line, the seller's extensions (a listing's
advertised request shape rides there) and the body. No wallet is opened and
nothing is signed. `-H 'Name: value'` sends a request header the endpoint asks
for, such as a provider's beta opt-in or an API version, on the probe and the
paid leg alike; the flag repeats. It refuses every name this command signs or
sets itself (the payment signature, sign-in-with-x, the session delegation, the
shelf bypass, the install id, the `payment-`/`x-payment` namespace) and the
transport headers (`host`, `content-length`, `content-type`, `user-agent`),
before any request leaves. The router's provider leg is unchanged: it still
passes only `accept` and `content-type` from a decision.

The Claude Code plugin gains `skills/tenjin-pay/SKILL.md`: quote first, pay
with the user's consent to that quote, `--max-price` always, `-H` for what the
endpoint asks for, and never another tool's wallet for a call this one can
make. `tenjin install` and `tenjin update` write it with the plugin's other
files, and `tenjin uninstall` removes it with them.
