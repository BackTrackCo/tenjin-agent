---
'tenjin-cli': patch
---

Paid jobs that finish later, and several takes of one call:

- A paid lookup whose seller answers before the result is ready (a queued video, a busy image render, a 202) is polled until it is done, for up to 5 minutes inside the call (in Claude Code, which moves a long call into the background, for as long as the seller says the job can take, with each poll reported as progress), and the file is saved as before. If it is still running then, the result says `running` with a `job` id, and `request({job})` checks it again later, from any session, paying nothing more. A 202 is never reported as a finished result.
- Polls go only to the seller's own host over HTTPS, and never carry a payment: a take costs its one payment, and a seller that asks for another to hand back the result gets nothing and the take fails.
- `request({id, input, count})` runs 2 to 5 takes of an image, video or audio call, each its own payment.
- One spend rule for every call: a call plans all its payments first, and their total is checked once against the per-call limit (`maxAutoSpend`, now the whole call's), the daily budget and the balance. A compare (`choice: "all"`) is planned at each option's live price.
- Over a limit, nothing is paid and the result says what it would cost ("5 takes of AiSpace (Hailuo 3 Max) cost $0.775 in total ($0.155 each)."). In Claude Code 2.1.214 or later, a new `approve` tool runs exactly that call once, and only through Claude Code's own permission prompt, which no mode or allow rule skips. Nobody is told to raise a limit.
