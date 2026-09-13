---
'tenjin-cli': minor
---

**Breaking.** A finding is a publish document, and that is the only shape:
frontmatter carrying `title` plus the answer-card keys, then the body.
`tenjin publish <file>` is the only command that takes one.

- The document is validated before anything is written. A missing title, or an
  answer card missing a rubric key, is refused with exit 2 naming the exact
  frontmatter keys to add, above the scan, the dedup answer, the confirm, the
  wallet and the network. `--draft` skips the card check and nothing else.
- The title is frontmatter `title`, else the body's first level-1 `# ` heading.
  No other heading level counts.
- Removed: `--dry-run` (validate-before-write is the preview), `--finding` and
  `--discard` with the local finding queue behind them, and every card-authoring
  flag on `publish` (`--question`, `--task`, `--scope`, `--exclusions`,
  `--applies-to`, `--as-of`, `--valid-until`, `--artifact-type`,
  `--temporal-mode`, `--provenance`, `--methodology`). The card is frontmatter or
  it is nothing. The same fields are gone from the `tenjin_publish` MCP tool,
  which is no longer annotated destructive; `tenjin edit` keeps its flags.
- The CLI fills nothing content-bearing. A named `--search-id` no longer copies
  its question into `questionsAnswered`; every card entry is the author's.

On the daemon side, the turn-end ask names the command and nothing else: the
fenced fallback, the harvest that read it, and the queued-findings lines are all
gone, and a stop after the ask writes its row and says nothing. A subagent's Read
on its own no longer earns it an ask.
