#!/usr/bin/env bash
# Rebuild repo.git, the one-commit git repository the runner cuts worktrees
# from, out of the plain files in repo/.
#
# repo/ is the readable copy and the one to edit. repo.git/ is a bare mirror of
# it, committed because a nested .git directory cannot be: git would record it
# as a gitlink and the files would never reach this repository.
#
# The commit is made with fixed identity and date, so the same tree always
# gives the same sha. Re-run this after editing anything under repo/, then put
# the sha it prints into pairs.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/repo"
bare="$here/repo.git"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/work"
rsync -a --exclude 'node_modules' --exclude '.git' "$src/" "$tmp/work/"

cd "$tmp/work"
git init --quiet --initial-branch=main
git add -A
GIT_AUTHOR_NAME='Ledgerline' \
  GIT_AUTHOR_EMAIL='eng@ledgerline.invalid' \
  GIT_AUTHOR_DATE='2026-01-05T09:00:00+00:00' \
  GIT_COMMITTER_NAME='Ledgerline' \
  GIT_COMMITTER_EMAIL='eng@ledgerline.invalid' \
  GIT_COMMITTER_DATE='2026-01-05T09:00:00+00:00' \
  git commit --quiet -m 'ledgerline 0.4.2'

sha="$(git rev-parse HEAD)"

rm -rf "$bare"
git clone --quiet --bare "$tmp/work" "$bare"
git --git-dir="$bare" symbolic-ref HEAD refs/heads/main

# The sample hooks the clone template leaves behind are a dozen files nobody
# reads; git is happy without the directory.
rm -rf "$bare/hooks"

echo "$sha"
