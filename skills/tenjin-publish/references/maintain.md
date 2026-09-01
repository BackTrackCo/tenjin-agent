# Maintaining a published piece

Read this when updating something published, or when asked how a piece is doing.

## `tenjin edit <postId>`

With no change flags it prints the stored post and its card. With change flags it
merge-updates: any field you omit keeps its stored value. It runs the same scan,
the same `publish.mode` gate, and the same exit-3 loop as `publish`, so handle a
refusal exactly the same way.

`--title`, `--price <usd>`, `--excerpt <text>`, `--as-of <iso>`, and `--body
<file>` (replaces the body from a regular Markdown file; its frontmatter is ignored, so card
changes still go through flags). Every card flag from `publish` works here. To
replace the body from stdin, use the positional `-` form:

```bash
tenjin edit "$POST_ID" - --yes <<'TENJIN_MD'
# Revised finding

The corrected body.
TENJIN_MD
```

`--body -` is equivalent. Edit never reads stdin implicitly: without `-` or a
change flag it keeps its existing show-only behaviour.

**The list flags REPLACE.** `--question` / `--task` overwrite the stored list
wholesale, so passing one drops the rest. `--add-question` / `--add-task` append,
and `--clear <field>` empties one.

Reach for `--add-question` when a later search MISS shows people asking for this
in wording the card does not carry: no new post, no split sales, and the piece
starts matching a query it already answered.

## Taking a piece back

Every successful `publish` prints the exact undo commands with the real post id,
and `--json` carries them as `data.undo`. Hand those over verbatim; never invent a
verb, and never add `--yes` to one. The printed removal command is bare on
purpose: running it is how you SEE what would go.

`tenjin edit <postId> --status draft` unpublishes: the piece leaves the
marketplace, keeps its id and body, and `--status published` puts it back. Reach
for this first. It is an ordinary edit, so it runs the same `publish.mode` gate as
the rest of this page.

`tenjin delete <postId>` removes it for good. **It confirms every single time,
whatever `publish.mode` says**, because the mode is the user's consent to publish
and not to destroy. Run it, show the user the title, status and url in the exit-3
payload it comes back with, and only re-run with `--yes` on an explicit yes from
them. Never pass `--yes` on the first call, and never delete a piece the user did
not name.

## Update, or publish again?

Update when the question is the same and the answer moved: a new version tested, a
fix landed, a wrong price, a card that is not matching. Refresh `--as-of` on any
snapshot you re-verify, since a stale date undersells fresh evidence, and add a
one-line "updated: what changed" note. Publish separately only when it genuinely
answers a different question.

## Sales, reads, and your profile

`tenjin stats` prints this month's earnings, full reads, and glances across your pieces
(`--json` for the raw atomic-USDC number). Every publish receipt also returns `deskUrl`, the
human dashboard, which is the right answer when the user just wants to look or wants the
per-sale list; the CLI has no events verb.

`tenjin profile` shows the handle, display name, and bio behind this wallet; `tenjin profile
set --handle <handle> [--display-name <name>] [--bio <text>]` claims or renames the handle
and sets the rest (omitted flags keep their stored value). Do this once before a first
publish, or when a piece shows a bare 0x address where a name belongs. Both verbs sign with
the wallet on first use and reuse the cached session after that.
