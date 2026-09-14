#!/usr/bin/env bash
# The verification matrix for the synthetic pairs.
#
#   bash evals/bench-lite/pairs/synthetic/verify.sh [pair-id ...]
#
# For each pair, in a throwaway worktree cut from repo.git:
#
#   producer, base                 must FAIL
#   producer, reference            must PASS
#   consumer, base                 must FAIL
#   consumer, naive                must FAIL   (the point of the pair)
#   consumer, reference            must PASS
#
# Reference and naive solutions live in reference/<pair>/*.patch and are never
# in the fixture repo, so nothing an agent under test can read holds an answer.
#
# Each case installs with --frozen-lockfile --prefer-offline and runs one test
# file. No servers, no whole-suite runs.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bare="$here/repo.git"
sha="$(git --git-dir="$bare" rev-parse HEAD)"
work="${BENCH_SYNTH_WORK:-${TMPDIR:-/tmp}/bench-lite-synthetic-verify}"

pairs=("$@")
if [ ${#pairs[@]} -eq 0 ]; then
  pairs=(
    settings-override-clear
    entry-ordering-ms
    job-audit-scope
    pricing-rule-kind
    config-reload-env
    content-key-digest
  )
fi

mkdir -p "$work"
rows=()
bad=0

run_case() {
  local pair="$1" role="$2" variant="$3" expect="$4"
  local dir="$work/${pair}__${role}__${variant}"
  local oracle="$here/oracles/$pair/$role.test.ts"
  local dest="tests/oracle/${pair}-${role}.test.ts"

  rm -rf "$dir"
  git --git-dir="$bare" worktree prune >/dev/null 2>&1
  if ! git --git-dir="$bare" worktree add --detach "$dir" "$sha" >/dev/null 2>&1; then
    printf '%s\n' "could not create a worktree at $dir"
    bad=$((bad + 1))
    return
  fi

  local note=''
  if [ "$variant" != base ]; then
    local patch="$here/reference/$pair/$variant.patch"
    if ! git -C "$dir" apply "$patch" >/dev/null 2>&1; then
      note='patch did not apply'
    fi
  fi

  local got='error'
  if [ -z "$note" ]; then
    (cd "$dir" && CI=true pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1)
    mkdir -p "$dir/tests/oracle"
    cp "$oracle" "$dir/$dest"
    if (cd "$dir" && CI=true pnpm vitest run "$dest" >/dev/null 2>&1); then
      got='pass'
    else
      got='fail'
    fi
  fi

  local verdict='OK'
  if [ "$got" != "$expect" ]; then
    verdict='BAD'
    bad=$((bad + 1))
  fi
  local line
  line="$(printf '%-24s %-8s %-16s want %-4s got %-5s %s' \
    "$pair" "$role" "$variant" "$expect" "$got" "$verdict$([ -n "$note" ] && echo " ($note)")")"
  rows+=("$line")
  printf '%s\n' "$line"

  git --git-dir="$bare" worktree remove --force "$dir" >/dev/null 2>&1
  rm -rf "$dir"
}

for pair in "${pairs[@]}"; do
  run_case "$pair" producer base fail
  run_case "$pair" producer producer pass
  run_case "$pair" consumer base fail
  run_case "$pair" consumer consumer-naive fail
  run_case "$pair" consumer consumer pass
done

git --git-dir="$bare" worktree prune >/dev/null 2>&1

echo
echo "base commit $sha"
if [ "$bad" -eq 0 ]; then
  echo "matrix: all $((${#rows[@]})) cases as expected"
else
  echo "matrix: $bad of ${#rows[@]} cases NOT as expected"
fi
exit "$bad"
