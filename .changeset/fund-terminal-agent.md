---
'tenjin-cli': minor
---

Adding funds no longer goes quiet. `tenjin fund` and `tenjin balance` are the new names (`tenjin wallet fund` and `tenjin wallet balance` still work). `tenjin fund` opens checkout in your browser and shows one live status line, in dollars: the page opening, the payment received, and the money added to your balance, ending on the new balance. It shows no wallet address or QR code unless you ask with `--crypto`, which shows the address to send USDC to, with the network warning first. Over SSH it shows a QR code of the checkout link, to pay on your phone. An expired link at a terminal says nothing was charged and offers `r` for a fresh one, and running it again while a payment is on its way waits on that payment instead of opening a second checkout. The link tells the page this computer's name, where it was asked for, and, with `--for` and `--price`, the paid call it is for.

`tenjin balance` shows your balance, your limits and how much is set aside for routing. `tenjin balance --wait` waits for funds to arrive and prints what was added; your agent runs it in the background after opening checkout, so it carries on when the money lands and never asks you to type "done". It asks about adding funds at most once a session. A spend limit that is used up says your balance is fine and how to raise the limit, and never opens checkout. The session-start balance notice is shown at most once a day.

Install says what your agent can now do, asks the spending question and the money question in fewer words, and after **Add $5** watches the payment and ends on your balance, your limits and the next step, with the privacy lines at the end.
