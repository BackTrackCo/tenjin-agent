---
'tenjin-cli': patch
---

Paid jobs that finish later, and several takes of one call:

- A paid lookup whose seller answers before the result is ready (a queued video, a busy image render, a 202) is polled until it is done, for up to 5 minutes inside the call, and the file is saved as before. If it is still running then, the result says `running` with a `job` id, and `request({job})` checks it again later, from any session, paying nothing more. A 202 is never reported as a finished result.
- Polls go only to the seller's own host over HTTPS, and never carry a payment: a take costs its one payment, and a seller that asks for another to hand back the result gets nothing and the take fails.
- `request({id, input, count})` runs 2 to 5 takes of an image, video or audio call, each its own payment. The whole set is checked against the per-call cap and the daily budget before anything is paid.
