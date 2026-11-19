---
'tenjin-cli': patch
---

Against a router that counts model calls at the quote, a DeepSeek worker's call that waited more than 100 seconds for its inference channel now asks for its quote again before it signs, so the router does not count the paid request a second time after the signature. A fresh quote that cannot be had, or that names another amount, ends that try with nothing signed or charged, and the call is tried again.
