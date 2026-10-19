---
'tenjin-cli': minor
---

`tenjin pay -H 'Name: value'` sends a request header the endpoint asks for, such
as a provider's beta opt-in or an API version, on the probe and the paid leg
alike. The flag repeats. It refuses every name this command signs or sets itself
(the payment signature, sign-in-with-x, the session delegation, the shelf bypass,
the install id, the `payment-`/`x-payment` namespace) and the transport headers
(`host`, `content-length`, `content-type`, `user-agent`), before any request
leaves. The router's provider leg is unchanged: it still passes only `accept`
and `content-type` from a decision.
