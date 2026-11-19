---
'tenjin-cli': minor
---

Add DeepSeek subagents for Claude Code, off by default. When they are on, Tenjin can offer DeepSeek V4.1 Flash, a cheap model, for an eligible subagent job, and Claude accepts or declines each offer. A call that gets no offer, or whose offer Claude declines, runs natively.

Who sees what: before each offer, Tenjin and TypeSafe get the task and recent conversation. When Claude accepts, Tenjin and DeepSeek get the task, its instructions and the worker's tool results, which include what the worker reads in `~/.claude` (session transcripts, prompt history and settings). The worker's web searches go to Exa. Known secrets and env file values are masked, which is not a guarantee.

Cost: a job's routing, inference and web searches together cost up to your per-call limit ($1 by default), or a lower ceiling you name with `--max-job`, within your daily budget. Routing costs up to $0.003 an offer, also when Claude declines it. Inference is the reported usage plus 5%. On a router that supports refunds, a run's unused inference deposit returns to your wallet when its worker ends.

Turn them on in fresh setup, with `tenjin install --subagents on`, or with `tenjin config subagents on`, which covers every workspace; `tenjin config subagents on --repository <path>...` covers only those directories and their subfolders. `tenjin config subagents off` turns them off. `tenjin config subagents` and `tenjin status` show whether they are on and where, and `tenjin config subagents why` lists why recent calls got no offer. Existing profiles and updates keep their settings. Codex support remains experimental. [Sharing, charges and controls](https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/subagents.md)
