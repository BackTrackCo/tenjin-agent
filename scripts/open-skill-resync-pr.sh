#!/usr/bin/env bash
# Scheduled half of skill-drift: re-sync the vendored mirror and, when the
# committed copy has drifted, park the refresh on one standing bot branch and
# open (or update) a single resync PR. Never merges — the mirror ships inside
# the npm package, so a human reads the content diff first.
#
# Idempotent by design: same branch, same changeset filename, one PR updated in
# place, so a week of drifting days leaves one PR rather than seven.
set -euo pipefail

BRANCH=bot/skill-resync
CHANGESET=.changeset/bot-skill-resync.md
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
cp skills/tenjin/SKILL.md "$synced"
git checkout -- skills/

pr_number=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // empty')

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

cp "$synced" skills/tenjin/SKILL.md

# The mirror ships in the package, so the refresh is a publishable change. Only
# write the changeset when the branch has none — a human may have reworded it.
if [ ! -f "$CHANGESET" ]; then
  cat >"$CHANGESET" <<'CHANGESET_BODY'
---
'tenjin-cli': patch
---

Resync the vendored zero-install skill from live tenjin.blog/skills.md.
CHANGESET_BODY
fi

if git diff --quiet HEAD --; then
  echo "skill-resync: PR #$pr_number already carries this mirror; nothing to push."
  exit 0
fi

git add skills/tenjin/SKILL.md "$CHANGESET"
git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m "$COMMIT_MESSAGE"

# Force-push is scoped to this one bot-owned branch, and only ever overwrites a
# branch with no open PR (the reset path above); with a PR open the push is a
# fast-forward on top of what reviewers already saw.
git push --force origin "HEAD:refs/heads/$BRANCH"

if [ -n "$pr_number" ]; then
  echo "skill-resync: updated PR #$pr_number."
  exit 0
fi

gh pr create --base main --head "$BRANCH" \
  --title "chore(skills): resync vendored skill mirror" \
  --body "$(
    cat <<BODY
Auto-opened by the daily \`skill-drift\` workflow: the vendored
\`skills/tenjin/SKILL.md\` no longer matches its canonical source,
$SOURCE_URL. The commit here is \`pnpm sync:skill\` output, nothing else.

The mirror ships inside the npm package, so this needs a human: read the
content diff, confirm the upstream wording is what you want agents to follow,
then merge. Automation only opens and refreshes this PR — it never merges it.

Drifting again on a later day updates this same PR in place.
BODY
  )"
