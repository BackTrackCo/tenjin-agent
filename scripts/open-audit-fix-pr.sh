#!/usr/bin/env bash
# Scheduled half of the audit: when `pnpm audit --audit-level=high` finds a high
# or critical advisory on main, apply pnpm's own fix (range-scoped caret
# overrides in pnpm-workspace.yaml), refresh the lockfile, and open (or update)
# one standing PR. Never merges.
#
# Why this exists: advisories publish against a frozen lockfile, CI's audit is
# warn-only (a blocking gate would red every open PR for drift unrelated to its
# diff), and Dependabot opens no PR for a pnpm transitive dependency held by an
# override. Before this, the first hard failure was release.yml's pre-publish
# gate, on release day. Now the fix PR lands the day the advisory does.
#
# Same shape as open-skill-resync-pr.sh: one bot branch, one PR updated in place.
set -euo pipefail

BRANCH=bot/audit-fix
TITLE='chore(deps): clear new high pnpm audit advisories'
COMMIT_MESSAGE="$TITLE"

cd "$(git rev-parse --show-toplevel)"

# `pnpm audit` also exits non-zero when the registry is unreachable. That case
# falls through to the fix below, which fails on the same network error and
# reds the run, which is the right outcome for a run that learned nothing.
if pnpm audit --audit-level=high >/dev/null; then
  echo "audit-fix: no high or critical advisories on main; nothing to do."
  exit 0
fi
echo "audit-fix: main has high or critical advisories."

# Only a SAME-REPO pull request may steer this run (see open-skill-resync-pr.sh:
# `gh pr list --head` matches the head-ref name alone, so a fork could otherwise
# park a branch with this name and silence the run).
pr_number=$(gh pr list --head "$BRANCH" --state open --json number,isCrossRepository \
  --jq 'map(select(.isCrossRepository == false)) | .[0].number // empty')

if [ -n "$pr_number" ]; then
  # A PR is under review: build on its branch so the review thread survives,
  # and stop if it already clears everything main is failing on. Merge main in
  # first: the branch can predate a dependency main has added since, and an
  # audit of the branch alone would pass while main still fails.
  main_sha=$(git rev-parse HEAD)
  git fetch origin "$BRANCH"
  git switch -C "$BRANCH" FETCH_HEAD
  if ! git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    merge --no-edit "$main_sha"; then
    # Both sides edit the overrides block, so a conflict in the two files this
    # script writes is the usual case, not an error. Take main's copy: the fix
    # below re-derives every override main still needs, the branch's included.
    # A conflict anywhere else is left unresolved, so the commit fails and stops
    # the run (set -e) for a person to look at.
    git checkout "$main_sha" -- pnpm-workspace.yaml pnpm-lock.yaml
    git -c user.name='github-actions[bot]' \
      -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit --no-edit
  fi
  pnpm install --no-frozen-lockfile --ignore-scripts
  if pnpm audit --audit-level=high >/dev/null; then
    echo "audit-fix: PR #$pr_number already clears every high advisory; nothing to push."
    exit 0
  fi
else
  # Nothing under review, so the branch is disposable: start from today's main.
  git switch -C "$BRANCH"
fi

# What the PR is about, captured before the fix rewrites the picture.
advisories=$(pnpm audit --audit-level=high --json | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    const { advisories = {} } = JSON.parse(raw);
    for (const a of Object.values(advisories)) {
      if (a.severity !== "high" && a.severity !== "critical") continue;
      const patched = a.patched_versions ?? "(none listed)";
      console.log(`- ${a.severity} \`${a.module_name}\` ${a.vulnerable_versions} -> ${patched}: ${a.github_advisory_id} ${a.title}`);
    }
  });
' || true)

pnpm audit --fix=override --audit-level=high
pnpm install --no-frozen-lockfile --ignore-scripts
# pnpm writes keys unquoted; keep the file in the repo's prettier shape.
pnpm exec prettier --write pnpm-workspace.yaml >/dev/null

# An advisory with no patched release can't be fixed by an override. That needs
# a person (upgrade the parent, or replace the dependency), so fail loudly
# rather than open a PR that doesn't clear the gate.
if ! pnpm audit --audit-level=high; then
  echo "::error title=pnpm audit::pnpm audit --fix could not clear every high advisory; it needs a manual fix"
  exit 1
fi

if git diff --quiet HEAD -- pnpm-workspace.yaml pnpm-lock.yaml; then
  echo "audit-fix: the fix changed nothing on $BRANCH; nothing to push."
  exit 0
fi

git add pnpm-workspace.yaml pnpm-lock.yaml
git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m "$COMMIT_MESSAGE"

if [ -n "$pr_number" ]; then
  # Fast-forward on top of what reviewers already saw; unforced, so a race
  # with a human push surfaces instead of overwriting it.
  git push origin "HEAD:refs/heads/$BRANCH"
  gh pr comment "$pr_number" --body "$(printf 'main moved since this PR opened and still fails the audit. The latest commits merge main and fix:\n\n%s\n\nIf that merge conflicted, pnpm-workspace.yaml and pnpm-lock.yaml were taken from main and the fix re-run, so check that no hand-written comment on this branch was dropped.\n' "$advisories")"
  echo "audit-fix: updated PR #$pr_number."
  exit 0
fi

# No PR open: the branch is bot-owned and disposable, so overwrite whatever an
# abandoned run left behind.
git push --force origin "HEAD:refs/heads/$BRANCH"

pr_body() {
  cat <<BODY
Auto-opened by the daily \`audit\` workflow: \`pnpm audit --audit-level=high\`
fails on main, which would also fail the pre-publish gate in \`release.yml\`.

$advisories

The commit is \`pnpm audit --fix=override --audit-level=high\` plus a lockfile
refresh: range-scoped caret overrides in \`pnpm-workspace.yaml\`. Optionally
add a comment line for each new entry (advisory id, which dependency pulls it in,
when it can be dropped), matching the entries already there. Delete any older
entry the new one supersedes.

No changeset: the published surface doesn't change. Automation opens and updates
this PR; it never merges it.
BODY
}

gh pr create --base main --head "$BRANCH" --title "$TITLE" --body "$(pr_body)"
