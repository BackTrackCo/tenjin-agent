---
'tenjin-cli': minor
---

The failure arm gets a second round: when neither fingerprint resolves, it asks the team shelf in WORDS, using the failure's own error line.

**Two rounds, ordered, never merged.** Round one is `/api/keys/resolve` under `sig_v1` and `sig_v1_test`. Round two runs only when round one answered nothing (the kernel already stops at the first stage that answers) and sends the error line as the runner printed it, masked, to `/api/search`. A key resolves a failure someone already published a key for; the write-up a teammate wrote about the same error in prose carries no fingerprint at all and used to be unreachable from a failing command.

**The team shelf only.** There is no public leg in either round: the marketplace holds none of this team's errors, and every hit in a 150-search census of this shelf came from the team side. The verdict is unchanged too — the shelf's own `strong`, no relaxed acceptance rule.

**A failure with an error line but no fingerprint now asks something.** `sigV1` refuses a line with no errno and no frame, and the arm used to fall silent there; it now asks in words.

**The once-per-question gate now keys on the error line as well as the fingerprints**, so two failures with different messages are two questions, and so are two failures that print the same message from different files.

**A totals row is no longer the end of the scan.** When the last error-shaped line is a runner's totals row and its block holds no diagnostic, the search now continues into the failure block the same run printed directly above it, across up to four blank lines. The arm splices stdout, stderr and the failure string with a newline apiece, which turns the single blank vitest prints before its summary into two — and two blanks are a block boundary, so a vitest failure with an ENOENT and a frame three lines up used to key nothing at all. The hop is one block and requires a runner header, so a totals-only output, or one with free text or an earlier command's error above it, still yields nothing.
