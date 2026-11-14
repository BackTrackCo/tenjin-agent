---
'tenjin-cli': patch
---

"Help improve routing" (`router.improve`), off by default and set for this machine only: while it is on, every hook and `request` call says `improve: true`, and Tenjin keeps that call's secret-masked packet so the router's offers can be graded. Install asks once, at a terminal (default No) or through the agent that runs it; a machine installed before this release, which its update does not ask, is asked once through its agent on the first prompt the router sees. Nothing asks again. `tenjin config set router.improve false` turns it off and asks Tenjin to delete what it kept. An offer your assistant was shown and never took is now reported once as `ignored` (it expired, or a native search ran instead), by id and with no text. Hook requests also carry a paste that Claude Code or the Codex desktop app marks as one in `quoted`, apart from your own words, and list the links on your repository's git host or claude.ai in `ownUrls`.
