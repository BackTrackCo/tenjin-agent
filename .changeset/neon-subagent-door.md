---
'tenjin-cli': patch
---

Add an opt-in Gemini 4 Neon subagent for writing jobs. `tenjin config neon on` gives its own consent, which names BlockRun and Google and is separate from DeepSeek subagents. The parent starts a worker by name with `subagent({neon: {prompt}})`; each model call is paid to BlockRun from your wallet within your limits, with no routing fee.
