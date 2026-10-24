---
'tenjin-cli': patch
---

Connect your own accounts. `tenjin connect apify` (or `fal`, `firecrawl`, or any MCP server by its https address) signs in through your browser; where no browser can open, `tenjin connect <name> --paste` takes a key at a hidden prompt in your own terminal, and `--from-env VAR` reads one from the environment once. Tenjin checks the account's tools for free, keeps the sign-in encrypted on this machine with its key in your OS keychain, and makes the account eligible for every job Tenjin knows it can do. It comes first for the checked jobs Tenjin's catalog marks to use it first for, and the rest stay available after Tenjin's own (a job your account can't do is left to Tenjin's own tool); `--no-prefer` leaves that out, and `tenjin config reset --source apify --preference` undoes it.

Calls on your account are billed to your own plan, not to your Tenjin balance, and don't count toward its limits. Each one ends with a receipt such as "Apify · your account · 20 places", and shows in `tenjin payments`. A job your account is still working on is checked again with `request({job})`, and the call that bills is never sent twice. A call whose charge is unknown (still running, failed after your account's job started, or answered with your account's own error) says "your Apify plan may have charged for this, not the Tenjin balance", and shows in `tenjin usage` and `tenjin payments` as "may have charged", never counted as billed; "nothing charged" is only for a call that never reached your account's job.

When your account refuses a call (its sign-in expired, or its plan or rate limit ran out), Tenjin stops, says why and how to fix it, and offers its own tool for the job with its price; nothing is charged until you pick. `tenjin config fallback on --source apify` runs Tenjin's tool in its place instead, and the receipt says so.

With "Run Tenjin's picks automatically" on (`tenjin config replacement on`), a checked job on your account also runs in place of a web search or page fetch when it is Tenjin's pick for it, billed to your own plan and held to the job's fixed caps: "Firecrawl · your account · instead of WebFetch". The provider choice applies to it as to any pick, and a job Tenjin hasn't checked never runs this way. If the account refuses before anything ran, the search or fetch stops once with the reason and Tenjin's own tool and its price; with `tenjin config fallback on` for that account, Tenjin's tool runs in its place, within your limits.

An account Tenjin has no map for runs only when you ask for it by name: your agent lists its tools for free and runs the one you need, with a note that Tenjin hasn't checked it and that your account pays.

`tenjin status` lists your accounts and the jobs each does, and `tenjin usage [--since 7d]` totals what lookups cost by day, from your balance and on each account. `tenjin disconnect apify` signs out where the account allows it and removes it from your preferences.
