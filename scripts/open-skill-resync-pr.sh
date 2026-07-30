#!/usr/bin/env bash
# Scheduled half of skill-drift: re-sync the vendored mirror and, when the
# committed copy has drifted, park the refresh on one standing bot branch and
# open (or update) a single resync PR. Never merges — the mirror ships inside
# the npm package and is loaded by agents as instructions, so a human reads the
# content diff first. Nothing here vouches for the wording; the merge does.
#
# Idempotent by design: same branch, same changeset filename, one PR updated in
# place, so a week of drifting days leaves one PR rather than seven.
#
# Covered by src/skill-resync-pr.test.ts, which drives this script against a
# local bare remote with the sync and `gh` stubbed.
set -euo pipefail

BRANCH=bot/skill-resync
CHANGESET=.changeset/bot-skill-resync.md
MIRROR=skills/tenjin/SKILL.md
SOURCE_URL=https://tenjin.blog/skills.md
COMMIT_MESSAGE="chore(skills): resync vendored mirror from tenjin.blog/skills.md"

cd "$(git rev-parse --show-toplevel)"

node scripts/sync-skill.mjs

if git diff --quiet -- skills/; then
  echo "skill-resync: mirror matches $SOURCE_URL; nothing to do."
  exit 0
fi
echo "skill-resync: mirror has drifted from $SOURCE_URL."

# Keep the fresh bytes aside: switching branches below needs a clean tree.
synced=$(mktemp)
trap 'rm -f "$synced"' EXIT
cp "$MIRROR" "$synced"
git checkout -- skills/

# The commit the refresh is measured against, captured while still on the
# checked-out default branch.
base_sha=$(git rev-parse HEAD)

# Only a SAME-REPO pull request may steer this run. `gh pr list --head` filters on
# the head-ref NAME alone, not the head repository, so without the
# isCrossRepository predicate anyone could fork this repo, push a branch called
# bot/skill-resync, open a PR from it, and own the variable every decision below
# turns on — silencing the resync signal this script exists to raise.
pr_number=$(gh pr list --head "$BRANCH" --state open --json number,isCrossRepository \
  --jq 'map(select(.isCrossRepository == false)) | .[0].number // empty')

if [ -n "$pr_number" ]; then
  # A PR is under review: build on its branch so the review thread survives.
  git fetch origin "$BRANCH"
  git switch -C "$BRANCH" FETCH_HEAD
else
  # No PR open means nothing is under review, so the branch is disposable:
  # reset it onto today's default branch rather than carrying a stale base (or
  # an already-released changeset) forward from an abandoned run.
  git switch -C "$BRANCH"
fi

cp "$synced" "$MIRROR"

# The mirror ships in the package, so the refresh is a publishable change. Only
# write the changeset when the branch has none — a human may have reworded it,
# and that wording ships in the changelog.
if [ ! -f "$CHANGESET" ]; then
  cat >"$CHANGESET" <<'CHANGESET_BODY'
---
'tenjin-cli': patch
---

Resync the vendored zero-install skill from live tenjin.blog/skills.md.
CHANGESET_BODY
fi

if git diff --quiet HEAD --; then
  echo "skill-resync: $BRANCH already carries this mirror; nothing to push."
  exit 0
fi

git add "$MIRROR" "$CHANGESET"
git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m "$COMMIT_MESSAGE"

if [ -n "$pr_number" ]; then
  # Fast-forward on top of what reviewers already saw. Deliberately unforced: if
  # a concurrent run or a human pushed after the fetch above, the rejection
  # surfaces the race instead of silently overwriting them. (A bare
  # `--force-with-lease` would be wrong here — CI's checkout carries no
  # remote-tracking ref for the bot branch, so its implicit lease expects the
  # branch not to exist and every update push would fail.)
  git push origin "HEAD:refs/heads/$BRANCH"
else
  # Nothing is under review, so the branch is disposable: overwrite whatever an
  # abandoned run left behind. Scoped to this one bot-owned branch.
  git push --force origin "HEAD:refs/heads/$BRANCH"
fi

# What the reviewer is actually being asked to judge: how much of the mirror
# moved, and whether the frontmatter moved with it — that block decides when an
# agent loads this skill at all, so a change there is a different kind of event
# from a copy edit. No reassurance about the wording: that is the unreviewed part.
frontmatter() { awk '{ print } /^---$/ { if (++seen == 2) exit }'; }
mirror_diff=$(git diff --numstat "$base_sha" HEAD -- "$MIRROR" | awk '{ print "+" $1 " / -" $2 }')
if [ "$(git show "$base_sha:$MIRROR" | frontmatter)" = "$(frontmatter <"$MIRROR")" ]; then
  frontmatter_note='unchanged'
else
  frontmatter_note='CHANGED — check name/description before merging'
fi

pr_body() {
  cat <<BODY
Auto-opened by the daily \`skill-drift\` workflow: the vendored \`$MIRROR\` no
longer matches its canonical source, $SOURCE_URL. The commit is
\`pnpm sync:skill\` output.

- Mirror diff: $mirror_diff lines
- Frontmatter: $frontmatter_note

No step in this path has read the new wording, so that is what the merge is for:
check the content diff, confirm it is what you want agents to follow, then merge.
Automation opens and refreshes this PR; it never merges it.

Drifting again on a later day updates this same PR, and these numbers, in place.
BODY
}

if [ -n "$pr_number" ]; then
  # Refresh the body so the magnitude above describes what is now on the branch.
  # The body is bot-owned review scaffolding, unlike the changeset above.
  gh pr edit "$pr_number" --body "$(pr_body)"
  echo "skill-resync: updated PR #$pr_number."
  exit 0
fi

gh pr create --base main --head "$BRANCH" \
  --title "chore(skills): resync vendored skill mirror" \
  --body "$(pr_body)"
