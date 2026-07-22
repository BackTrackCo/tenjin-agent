# tenjin-cli

## 0.1.0-alpha.2

### Minor Changes

- b08323e: Publish from the CLI. `tenjin publish <file.md>` ships a Markdown piece with an
  optional answer card (question/task/scope/exclusions/applies-to and more, from
  frontmatter or flags), gated by a deterministic local scan that hard-blocks
  secrets and surfaces PII, wallet addresses, and long verbatim quotes for review.
  A `publish.mode` consent cascade (`review` / `auto` / `full-auto`, with a
  loosening gate on committed project config) governs whether a publish asks first,
  and `tenjin install` can set the mode once during setup. Writes are signed with an
  RFC 9421 P-256 session key delegated by a single wallet signature, so a returning
  publisher never re-signs until it expires.

  Park and publish drafts locally: `tenjin candidate add/list/drop` stores drafts
  that never upload on their own, and `tenjin publish --candidate <id>` publishes a
  parked candidate through the same scan and consent flow, clearing it on success.

  New config keys `publish.mode` and `publish.defaultPrice` (settable via
  `tenjin config set` or a per-project `.tenjin.json`) control the default consent
  mode and price.
