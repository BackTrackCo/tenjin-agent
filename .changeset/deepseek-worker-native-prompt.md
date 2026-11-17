---
'tenjin-cli': patch
---

A DeepSeek worker now runs with the prompt Claude Code gives a native subagent of its type, read when the worker starts from the Claude Code that runs it, in place of Claude Code's main prompt, and without the main conversation's own tools such as scheduling a wake-up or a cron job. When that prompt cannot be read, the worker starts as before and Tenjin's MCP server logs why. Tool search is on in the worker as in your session: MCP tools and the less used built-in tools load when the worker asks for them, so a worker's first request is about half its former size.
