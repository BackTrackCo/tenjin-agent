---
'tenjin-cli': patch
---

Add a Neon writing subagent for writing jobs. The parent starts a worker with `subagent({neon: {prompt}})` when you, or a skill you run, ask for it. Nothing turns it on or off, and the DeepSeek subagent setting does not change it. The Tenjin router names the provider of each job in one free lookup, and each model call is paid from your wallet to that provider within your limits, with no routing fee. When a job ends, the rest of its payment channel returns to your wallet. `tenjin refund` asks again if that failed, and starts the channel's timed withdrawal where the provider does not answer. A revision past the job's ceiling asks you before it sends anything.
