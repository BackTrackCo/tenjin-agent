---
'tenjin-cli': patch
---

Every payment this CLI brokers now carries Tenjin's ERC-8021 builder code
(`bc_kc0altv3`) as the client service code, so CLI-brokered volume is
attributed, where the facilitator encodes it.

`buildExactPayment` registers the SDK's `BuilderCodeClientExtension` before it
signs, which puts the code in the payload's `s` field. Both `buy` and `pay` sign
through that one function, so first-party and Bazaar-lane payments are covered
by the same line. The SDK fires the hook only for sellers whose 402 advertises
the standard `builder-code` extension; a seller who never declared it still gets
an extension-free payload, and nothing about the payment terms changes either
way: same amount, payee, network, and asset, with attribution riding as
metadata beside them.

Attribution, not proof. The suffix reaches the chain only when the settling
facilitator has the builder-code extension registered, and `s` is
unauthenticated and seller-writable, so an occurrence of the code is not
evidence that this CLI brokered the payment.
