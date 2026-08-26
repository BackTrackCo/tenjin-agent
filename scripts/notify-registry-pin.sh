#!/usr/bin/env bash
# Post-publish half of release.yml: file one issue on BackTrackCo/tenjin saying
# the MCP Registry pin for tenjin-cli is now behind.
#
# The registry listing for blog.tenjin/tenjin advertises this CLI as an npm stdio
# package at an EXACT version (ranges are rejected), and that pin lives in the
# other repo, so a release here silently stales it. Nothing else detects that:
# tenjin's own drift test asserts the literal against itself, and the registry
# only validates at publish time, weeks later (tenjin-agent#98).
#
# Notify only. The bump is a judgement call (not every alpha is worth
# advertising) and the registry publish itself needs an operator signing key
# after a promoted deploy, so no PR is opened and nothing is published from here.
#
# Covered by src/notify-registry-pin.test.ts, which drives this script with `gh`
# stubbed.
set -euo pipefail

# release.yml pins both; they stay overridable for the manual recovery path in
# RELEASING.md.
TARGET_REPO="${TARGET_REPO:-BackTrackCo/tenjin}"
PACKAGE="${PACKAGE:-tenjin-cli}"

# The whole feature hangs off two changesets/action outputs. An upgrade that
# renames or drops one arrives here as an empty string, so empty must mean "the
# action did not report", loudly, and never read as "it reported false", which is
# the silence this script exists to end. release.yml runs this step for every
# `published` other than a literal false, and hands the value over unchanged.
published="${PUBLISHED:-}"
if [ -z "$published" ]; then
  echo "notify-registry-pin: FAIL, PUBLISHED is empty. changesets/action reported no" >&2
  echo "  \`published\` output; re-check the step wiring in .github/workflows/release.yml." >&2
  exit 1
fi

if [ "$published" != "true" ]; then
  echo "notify-registry-pin: publish reported published=$published; nothing to file."
  exit 0
fi

# The companion output names what actually went to npm. Malformed JSON throws out
# of node and kills the script under `set -e`, and a publish that claims success
# while naming nothing is the same broken wiring as above.
summary=$(PACKAGE="$PACKAGE" node -e '
  const published = JSON.parse(process.env.PUBLISHED_PACKAGES || "[]");
  if (!Array.isArray(published)) throw new Error("PUBLISHED_PACKAGES is not a JSON array");
  const hit = published.find((p) => p && p.name === process.env.PACKAGE);
  process.stdout.write(published.length + " " + (hit ? String(hit.version) : ""));
')
count="${summary%% *}"
version="${summary#* }"

if [ "$count" = "0" ]; then
  echo "notify-registry-pin: FAIL, published=true but PUBLISHED_PACKAGES names no package." >&2
  echo "  The two changesets/action outputs disagree; re-check .github/workflows/release.yml." >&2
  exit 1
fi

if [ -z "$version" ]; then
  echo "notify-registry-pin: no $PACKAGE in this publish; nothing to file."
  exit 0
fi

# Deliberately NOT the release-bot App token minted upstream in this job, which
# cannot write an issue on another repo. Full rationale: RELEASING.md, "One-time
# owner setup". Fail loudly rather than swallow the notification.
if [ -z "${GH_TOKEN:-}" ]; then
  echo "notify-registry-pin: FAIL, no GH_TOKEN. Set the RELEASE_CROSSREPO_TOKEN secret" >&2
  echo "  (fine-grained PAT, Issues: read and write on $TARGET_REPO)." >&2
  exit 1
fi

export TITLE="bump the MCP Registry packages pin to $PACKAGE@$version"

# `--search` matches loosely (word-ish, and the version is punctuation-heavy), so
# it only narrows the page; the exact-title predicate is what decides. Without it
# a near-miss (the PREVIOUS version's issue, still open) would swallow this
# release's notification. `env.TITLE` keeps the title out of the jq source, so a
# title can never be read as a filter.
#
# Dedupe is best effort by construction: search is full-text over one page, and
# GitHub's index lags a fresh issue by seconds to minutes, so a recall miss files
# a second issue. Noise, not harm. The version phrase alone keeps prose words from
# diluting recall, and the page is widened past the 30-result default.
existing=$(gh issue list --repo "$TARGET_REPO" --state open --limit 200 \
  --search "\"$PACKAGE@$version\" in:title" \
  --json number,title --jq 'map(select(.title == env.TITLE)) | .[0].number // empty')

if [ -n "$existing" ]; then
  echo "notify-registry-pin: $TARGET_REPO#$existing already asks for this bump."
  exit 0
fi

opener="the tenjin-agent release workflow"
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  opener="[the tenjin-agent release run](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-BackTrackCo/tenjin-agent}/actions/runs/${GITHUB_RUN_ID})"
fi

# The heredoc writes a file rather than feeding a $(...) capture, because
# `gh --body-file` reads one directly.
body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT
cat >"$body_file" <<BODY
\`$PACKAGE@$version\` is on npm. The MCP Registry listing for \`blog.tenjin/tenjin\`
still points agents at whatever this repo's \`server.json\` pins, and the registry
rejects ranges, so the pin only moves by hand.

Bump it if this release is worth advertising; not every alpha is. Three files move
together in this repo:

- \`server.json\`: \`packages[0].version\` is the pin. \`version\` is the manifest
  version and must equal \`package.json\`'s (\`server.json.test.ts\` asserts both, so
  the pin literal moves with it).
- \`package.json\`: bump \`version\` only if the manifest version moves.
- \`lib/mcp/metadata.ts\`: \`MCP_SERVER_INFO\` derives its version from
  \`package.json\`, so it follows that bump rather than being edited (it moved here
  from \`lib/mcp/server.ts\` in #493).

Publishing the updated manifest to the MCP Registry is manual and must follow the
promoted deploy: the signing key is an operator credential. Runbook and preflight:
\`docs/MCP-REGISTRY.md\`.

Opened by $opener after publishing \`$PACKAGE@$version\`.
BODY

gh issue create --repo "$TARGET_REPO" --title "$TITLE" --body-file "$body_file"
