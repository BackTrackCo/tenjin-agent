#!/usr/bin/env bash
# Rebuild repo.git, the one-commit git repository the runner cuts worktrees
# from, out of the files in repo/.
#
# repo/ is unjs/h3 at tag v1.15.11 plus two toolchain lines (see NOTES.md), and
# it is the readable copy: edit there. repo.git/ is a bare mirror of it,
# committed because a nested .git directory cannot be: git would record it as a
# gitlink and the files would never reach this repository.
#
# The tree is squashed to a single commit rather than carrying h3's history,
# which would add tens of megabytes to this repository. The upstream URL and
# commit are in the commit message and in NOTES.md, so the real history is one
# `git clone` away.
#
# The commit is made with fixed identity and date, so the same tree always
# gives the same sha. Re-run this after editing anything under repo/, then put
# the sha it prints into pairs.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/repo"
bare="$here/repo.git"

UPSTREAM_URL='https://github.com/h3js/h3'
UPSTREAM_TAG='v1.15.11'
UPSTREAM_SHA='7b9f41fda6038d26a367c2a26a07ed83ee1dbaac'

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/work"
rsync -a --exclude 'node_modules' --exclude '.git' "$src/" "$tmp/work/"

cd "$tmp/work"
git init --quiet --initial-branch=main
git add -A
GIT_AUTHOR_NAME='bench-lite fixture' \
  GIT_AUTHOR_EMAIL='bench-lite@invalid' \
  GIT_AUTHOR_DATE='2026-01-05T09:00:00+00:00' \
  GIT_COMMITTER_NAME='bench-lite fixture' \
  GIT_COMMITTER_EMAIL='bench-lite@invalid' \
  GIT_COMMITTER_DATE='2026-01-05T09:00:00+00:00' \
  git commit --quiet -m "h3 ${UPSTREAM_TAG} (${UPSTREAM_SHA})

Upstream: ${UPSTREAM_URL}, MIT licence, LICENSE kept verbatim.
Squashed to one commit; see NOTES.md for the two toolchain lines added on top."

sha="$(git rev-parse HEAD)"

rm -rf "$bare"
git clone --quiet --bare "$tmp/work" "$bare"
git --git-dir="$bare" symbolic-ref HEAD refs/heads/main

# The sample hooks the clone template leaves behind are a dozen files nobody
# reads; git is happy without the directory.
rm -rf "$bare/hooks"

echo "$sha"
