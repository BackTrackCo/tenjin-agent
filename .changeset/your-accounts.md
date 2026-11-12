---
'tenjin-cli': patch
---

Connect your own accounts. `tenjin connect apify` (or `fal`, `firecrawl`, or any MCP server by its https address) signs in through your browser; where no browser can open, `tenjin connect <name> --paste` takes a key at a hidden prompt in your own terminal, and `--from-env VAR` reads one from the environment once. Tenjin checks the account's tools for free, keeps the sign-in encrypted on this machine with its key in your OS keychain, and puts the account first for its jobs; `--no-prefer` leaves that out, and `tenjin config reset --source apify --preference` undoes it. `tenjin disconnect apify` signs out where the account allows it and removes it from your preferences.

Calls on your account are billed to your own plan, not your Tenjin balance, and don't count toward its limits; routing an offer on your account still costs at least $0.001 from the balance. Each call ends with a receipt such as "Apify · your account · 2 places" and shows in `tenjin payments`. When your account refuses a call (its sign-in expired, or its plan or rate limit ran out), Tenjin stops, says why and how to fix it, and offers its own tool for the job with its price; nothing is charged until you pick, and `tenjin config fallback on --source apify` runs Tenjin's tool in its place instead. A job Tenjin hasn't checked on your account runs only when you ask for it by name, with a note that Tenjin hasn't checked it, and so does an account Tenjin has no map for.

`tenjin status` now leads with whether Tenjin is on, then your balance, today's spending against your daily limit, your connected accounts and their jobs, and your settings in plain words. `tenjin usage [--since 7d]` totals what lookups cost by day, from your balance and on each account.
