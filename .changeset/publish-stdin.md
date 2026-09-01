---
'tenjin-cli': patch
---

Accept Markdown on standard input for publishing and body edits:

- `tenjin publish -` reads stdin explicitly.
- Bare `tenjin publish` reads stdin only when it is non-interactive.
- `tenjin edit <post-id> -` replaces a post body from stdin.

Interactive bare publishes still return usage immediately, and MCP stdio is never
exposed to either command as content.

The installed publish skill and capture hooks now prefer the stdin form. When a
regular file is used instead, they require `tenjin publish <file>` to run as its own bare
shell/tool command so the installed `Bash(tenjin publish:*)` prefix permission
can recognize it.
