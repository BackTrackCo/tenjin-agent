---
'tenjin-cli': patch
---

A DeepSeek consent given before a worker could read your `~/.claude` folder no longer qualifies: no offer is made until you renew it. `tenjin config subagents why` shows `consent_outdated`, and running `tenjin config subagents on --repository <path> --max-job <USD>` again shows the current terms and renews the consent for the directories you name, keeping those an earlier consent named. New installs are told at setup that a helper can read that folder. A name under `~/.claude` that is a link to a protected file, such as the credentials file, stays closed to a worker.
