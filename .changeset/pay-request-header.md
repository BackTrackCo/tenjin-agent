---
'tenjin-cli': minor
---

Paying an endpoint can now start with a free quote, and the plugin teaches an
agent to quote first and then pay with this machine's wallet.

A quote decodes the endpoint's 402 and reports every payment option, the
resource line, the seller's extensions (a listing's advertised request shape
rides there) and the body. No wallet is opened and nothing is signed. Only a
USDC option carries a dollar amount, and the option the paid path would sign is
marked payable, chosen by the same selection. The headline prices that option,
or says the endpoint lists none this wallet can pay, so an 18-decimal option a
seller lists first is never shown as dollars.

A paid call can send a request header the endpoint asks for, such as a
provider's beta opt-in or an API version, on the probe and the paid leg alike,
and it can send several. Every header the CLI signs or sets itself is refused
before any request leaves: the payment signature, sign-in-with-x, the session
delegation, the shelf bypass, the install id, the payment header namespace and
the transport headers (host, content length, content type, user agent). The
router's provider leg is unchanged: it still passes only the accept and content
type headers from a decision.

A paid call now takes GET, POST, PUT, PATCH or DELETE, and a body needs POST,
PUT or PATCH. A body that is not JSON goes byte for byte under the content type
sent with it, the one case where that header may be set.

The Claude Code plugin gains a `tenjin-pay` skill: quote first, cap the price
at the payable option, pay with the user's consent to that quote, send the
headers the endpoint asks for, and never use another tool's wallet for a call
this one can make. Install and update write it with the plugin's other files,
and uninstall removes it with them.
