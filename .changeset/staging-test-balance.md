---
'tenjin-cli': patch
---

`tenjin wallet balance` pointed at a non-production Tenjin server (`--base-url`) now also shows the Transak staging test funds that server announces, as "Test funds on Base Sepolia: N TRNSK (Transak staging)", after the real USDC line. Production makes no extra request, and payments, deposits, and spend decisions still use only USDC on Base.
