---
'tenjin-cli': minor
---

The failure arm's mechanical error-to-fix record is deleted. It only asks now.

**The local pairing lane is gone.** The daemon no longer opens, closes, verifies or replays a record of its own: it inferred the fix from whichever files an agent edited plus a later passing command, and measured against ten real fixes it matched none of them, while an unrelated `pnpm test` could close a failed `pnpm db:migrate` through a file that only shared a basename. `pairings` and `pairing_closes` are DROPPED from `loop.db` on the next open, deliberately and permanently — there is no migration ladder, and a table nothing lists is a table nothing would ever clean up.

**The failure arm now only asks.** Round one sends the failure's `sig_v1` and `sig_v1_test` fingerprints to `/api/keys/resolve`; round two, only if the first answered nothing, sends the error line in words to the team shelf. A machine with no team origin asks nothing at all behind a failing command, where it used to read a test report and consult itself.

**The `local` shelf and its opener are gone**, so nothing is ever injected as a record from this machine. A parked handoff still reaches a starting child, under the shelf its own answer came off.

**The turn-end ask no longer names fixed-but-unwritten errors**, and `doctor` no longer counts them. `tenjin publish --key fingerprint=sig_v1:<hash>` survives as a hand flag for the server-side key registry that round one resolves against — but nothing on the machine hands an agent a key any more, so it is a flag a person spells out.

**`~/.tenjin/loop.db` is still kept by uninstall**, for the search record and the outcome history.
