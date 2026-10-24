---
'tenjin-cli': patch
---

The package ships about 0.5 MB less JavaScript. Sign-in-with-x messages are built with viem's EIP-4361 helper instead of the x402 SDK's, whose Solana support brought in tweetnacl, apg-js and two SIWE parser packages Tenjin never used. The signed message and the header are byte for byte what they were.
