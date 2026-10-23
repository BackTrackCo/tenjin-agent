---
'tenjin-cli': patch
---

Tell your agent what Tenjin may use, and it changes your settings for you. `tenjin config prefer`, `only`, `block`, `unblock` and `reset` save a rule by the names you use ("prefer Exa for web research", "never use Firecrawl", "only use Tenjin for images"), and each answers with what it saved, what it covers and the one command that undoes it. `tenjin config` shows what you have changed, and `tenjin config --help` lists every operation with an example. A name that matches more than one thing, or nothing, saves nothing and lists what it could mean. Settings stay in `~/.tenjin/config.json` on this machine; a project's files cannot add a rule.

Every call through Tenjin is held to your settings. The router applies them when it picks a service, and Tenjin checks them again right before it calls a provider or signs a payment, so a block you save in another terminal stops the next call, an offer made a minute earlier included. A compare or "all" set with one blocked member runs none of them and names the ones that could run alone. When your settings stop a call, the result names the setting and says nothing was sent or paid, and your agent is told to leave your settings alone. Settings Tenjin cannot read stop paid calls until you fix or reset them, while `tenjin config`, pausing and resetting keep working offline.

New: "Run Tenjin's picks automatically", off by default. `tenjin config replacement on --all-providers` (or `--provider exa` for only Exa) lets Claude Code with the Tenjin plugin run Tenjin's pick in place of a web search or page fetch, when the router picks a service for it with its usual confidence. It runs within your settings and limits; a call over a limit is offered as usual and asks first. Each one shows in the transcript and on the call's own row ("in place of Web Search"), and in `tenjin payments`. `tenjin config replacement off` turns it off.

Your limits now say they cap your Tenjin balance: `tenjin status` reads "Today $0.30 of your $5.00 daily limit (Tenjin balance, over the last 24 hours)".

This is the first version that enforces these settings. An older version ignores them, so keep Tenjin up to date on every machine where you save them.
