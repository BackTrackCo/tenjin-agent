#!/usr/bin/env bash
# Rebuild the vendored Vitest archive from one fixture's lockfile.
#
#   evals/benchmark/scripts/vendor-vitest.sh [fixture] [id]
#
# Installs the fixture's pinned tree with pnpm (the one network step), packs
# it as evals/benchmark/fixtures/live/vendor/<id>.tar.gz with its record, and
# puts the fixture back to its committed shape: only the .bin/vitest shim under
# node_modules. The archive is platform-specific; run it on the platform the
# id names. A rebuild changes every fixture_hash that names the id, so the
# manifests re-pin and bump their benchmark_version.
set -euo pipefail
cd "$(dirname "$0")/../../.."
fixture=${1:-evals/benchmark/fixtures/live/actor}
id=${2:-vitest-3.2.4-node24-darwin-arm64}
(cd "$fixture" && pnpm install --frozen-lockfile)
python3 -m evals.benchmark.vendor build --fixture "$fixture" --id "$id" --pnpm "$(pnpm --version)"
git clean -fdxq -- "$fixture/node_modules"
git checkout -- "$fixture/node_modules/.bin/vitest"
