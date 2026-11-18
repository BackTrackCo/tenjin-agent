---
'tenjin-cli': patch
---

`tenjin fund` now sends a hash of this computer's ID, never the ID itself, so an event or promo code entered under **Have a code?** on the fund page can be redeemed once per computer. An agent asked to use a code runs `tenjin fund` and has the person type the code on that page, never in chat.
