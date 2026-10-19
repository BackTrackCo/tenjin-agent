---
'tenjin-cli': minor
---

`tenjin pay` can read a paid endpoint before it pays one, and the plugin now
teaches an agent to do both with this machine's wallet.

`tenjin pay <url> --quote` decodes the 402 and reports every payment option,
the resource line, the seller's extensions (a listing's advertised request shape
rides there) and the body. No wallet is opened and nothing is signed. Only a
USDC option carries `usd`, and `payable: true` marks the option the paid path
would sign, chosen by the same selection. The headline prices that option, or
says the endpoint lists none this wallet can pay, so an 18-decimal option a
seller lists first is never shown as dollars.

`-H 'Name: value'` sends a request header the endpoint asks for, such as a
provider's beta opt-in or an API version, on the probe and the paid leg alike;
the flag repeats. It refuses every name this command signs or sets itself (the
payment signature, sign-in-with-x, the session delegation, the shelf bypass,
the install id, the `payment-`/`x-payment` namespace) and the transport headers
(`host`, `content-length`, `content-type`, `user-agent`), before any request
leaves. The router's provider leg is unchanged: it still passes only `accept`
and `content-type` from a decision.

`-X` now takes GET, POST, PUT, PATCH or DELETE. A body needs POST, PUT or
PATCH. `--data-raw <text>` sends a body that is not JSON byte for byte. It needs
`-H 'Content-Type: <type>'`, the one case where `-H` may set that header, and it
cannot be combined with `--data`.

The Claude Code plugin gains `skills/tenjin-pay/SKILL.md`: quote first, take
`--max-price` from the `payable` option, pay with the user's consent to that
quote, `-H` for what the endpoint asks for, `--data-raw` for a body that is not
JSON, and never another tool's wallet for a call this one can make.
`tenjin install` and `tenjin update` write it with the plugin's other files, and
`tenjin uninstall` removes it with them.
