---
'tenjin-cli': patch
---

A prompt never carries the routing deposit any more, so a deposit no longer costs a prompt its routing hint. `tenjin mcp` sets funds aside for routing in the background, with one `warm` call to the router that is charged nothing and carries the deposit: when it starts on a channel that cannot cover a fee (a new one included), and right after a paid call leaves the channel that low. A routing call that meets one in progress waits for it inside its own time limit, then pays from the channel. A wallet too low for the deposit is told once, with its balance, and the balance is read only for the top-up; after a low wallet, the next top-up is tried within 2 minutes. A router without the `warm` form gets the deposit on the next paid call for an hour, as before. When a session ends mid top-up, `tenjin mcp` waits up to 30 seconds for it to land before it exits.
