---
'tenjin-cli': patch
---

`tenjin publish` now warns before a card-less or incomplete answer card is
published, not only after. Previously the only word of it was the receipt
printed after the write, so `auto` with no scan warns, `full-auto`, and any
`--yes` run reached the network in total silence; the `review` confirm carried
the card's missing fields in its JSON `details.card` but never rendered them
for a human. Both are fixed: a stderr notice prints before the wallet is
touched, unconditionally in every mode, naming what is missing, and the
`review`/`auto`-with-findings confirm now renders `incomplete answer card: ...`
under the same lines a scan finding gets. Neither touches ranking or
filtering — that is the receipt's business — this is about the card's own
completeness, the buyer's pre-purchase read on fit.
