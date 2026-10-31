---
'tenjin-cli': patch
---

Reduce cold wallet unlock time with hash-wasm inside the existing disposable worker. Wallet encryption parameters, passphrase storage and recovery stay unchanged; Ox still handles other keystore formats and verifies and decrypts wallet contents. This improves the unlock portion of first use, not payment settlement or server routing latency.
