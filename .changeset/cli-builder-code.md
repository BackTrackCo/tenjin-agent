---
'tenjin-cli': patch
---

Every payment this CLI brokers now carries Tenjin's ERC-8021 builder code
(`bc_kc0altv3`) as the client service code, so CLI-brokered volume is provable
on-chain.

`buildExactPayment` registers the SDK's `BuilderCodeClientExtension` before it
signs, which puts the code in the payload's `s` field. Both `buy` and `pay` sign
through that one function, so first-party and Bazaar-lane payments are covered
by the same line. The SDK fires the hook only for sellers whose 402 advertises
the standard `builder-code` extension; a seller who never declared it still gets
an extension-free payload, and nothing about the payment terms changes either
way: same amount, payee, network, and asset, with attribution riding as
metadata beside them.
