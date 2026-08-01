#!/usr/bin/env bash
# Packed-artifact smoke test for tenjin-cli.
#
# Source-tree unit tests run against src/; they cannot catch a chunk that got
# externalized instead of bundled (published `dependencies` is `{}`) or a file
# missing from the package's `files` allowlist. This packs the real tarball,
# installs it into a throwaway consumer, and exercises the PUBLISHED shape.
#
# Self-contained and runnable locally (`pnpm --filter tenjin-cli run pack-smoke`)
# as well as in CI. Paths are derived from this script's location, so the working
# directory does not matter. Every CLI invocation points TENJIN_DATA_DIR at a
# fresh temp dir — never the runner's real ~/.tenjin.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PACK_DIR="$(mktemp -d)"
CONSUMER_DIR="$(mktemp -d)"
DATA_DIR="$(mktemp -d)"
HOME_DIR="$(mktemp -d)"
cleanup() { rm -rf "$PACK_DIR" "$CONSUMER_DIR" "$DATA_DIR" "$HOME_DIR"; }
trap cleanup EXIT

export TENJIN_DATA_DIR="$DATA_DIR"

# The `check` CI step builds first; only rebuild if the entry is genuinely absent
# (e.g. a bare local run) so this stays cheap on the CI path.
if [ ! -f "$PKG_DIR/dist/index.js" ]; then
  echo "pack-smoke: dist/index.js missing, building tenjin-cli..."
  pnpm --filter tenjin-cli run build
fi

EXPECTED_VERSION="$(node -e "process.stdout.write(require('$PKG_DIR/package.json').version)")"

echo "pack-smoke: packing tenjin-cli@$EXPECTED_VERSION"
TARBALL_NAME="$(cd "$PKG_DIR" && npm pack --pack-destination "$PACK_DIR" 2>/dev/null | tail -n1)"
TARBALL="$PACK_DIR/$TARBALL_NAME"
[ -f "$TARBALL" ] || {
  echo "pack-smoke: FAIL — npm pack produced no tarball" >&2
  exit 1
}

echo "pack-smoke: installing $TARBALL_NAME into a throwaway consumer"
cd "$CONSUMER_DIR"
npm init -y >/dev/null 2>&1
# `dependencies` is {}, so this resolves nothing from the registry — no network.
npm install "$TARBALL" --no-audit --no-fund >/dev/null 2>&1

BIN="./node_modules/.bin/tenjin"
[ -x "$BIN" ] || {
  echo "pack-smoke: FAIL — installed package exposes no tenjin bin" >&2
  exit 1
}

# From here on every invocation is a CLI invocation, and the post-command skills
# hook writes into harness directories under HOME. Isolate it for ALL of them,
# not just the self-heal leg, or this script rewrites the runner's own
# ~/.claude/skills. Set after npm, which needs the real HOME for its own config.
export HOME="$HOME_DIR"

# The README links docs/agent-permissions.md package-locally, so dropping `docs`
# from the files array must fail here, not leave a dead link while CI stays green.
[ -f "./node_modules/tenjin-cli/docs/agent-permissions.md" ] || {
  echo "pack-smoke: FAIL — docs/agent-permissions.md missing from the installed package" >&2
  exit 1
}

# 1) --version prints exactly the package.json version.
GOT_VERSION="$("$BIN" --version)"
if [ "$GOT_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "pack-smoke: FAIL — --version printed '$GOT_VERSION', expected '$EXPECTED_VERSION'" >&2
  exit 1
fi
echo "pack-smoke: --version -> $GOT_VERSION (ok)"

# 2) `tenjin config` exits 0 and prints a JSON envelope carrying schemaVersion.
# JSON is validated by node (not jq — not guaranteed on a runner): a fixed script
# reads the captured stdout on its own stdin and exits nonzero on a bad envelope.
set +e
CONFIG_OUT="$("$BIN" config)"
CONFIG_CODE=$?
set -e
if [ "$CONFIG_CODE" -ne 0 ]; then
  echo "pack-smoke: FAIL — 'tenjin config' exited $CONFIG_CODE, expected 0" >&2
  echo "$CONFIG_OUT" >&2
  exit 1
fi
printf '%s' "$CONFIG_OUT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let o;
    try {
      o = JSON.parse(s);
    } catch (e) {
      console.error("config: stdout is not JSON: " + e.message);
      process.exit(1);
    }
    if (o.schemaVersion === undefined || o.command !== "config") {
      console.error("config: unexpected envelope: " + s);
      process.exit(1);
    }
  });
' || {
  echo "pack-smoke: FAIL — 'tenjin config' stdout is not the expected JSON envelope" >&2
  exit 1
}
echo "pack-smoke: config -> exit 0, JSON envelope with schemaVersion (ok)"

# 3) A bogus subcommand exits 2 with a parseable JSON error envelope.
set +e
BOGUS_OUT="$("$BIN" definitely-not-a-real-command 2>/dev/null)"
BOGUS_CODE=$?
set -e
if [ "$BOGUS_CODE" -ne 2 ]; then
  echo "pack-smoke: FAIL — bogus subcommand exited $BOGUS_CODE, expected 2" >&2
  exit 1
fi
printf '%s' "$BOGUS_OUT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let o;
    try {
      o = JSON.parse(s);
    } catch (e) {
      console.error("bogus: stdout is not JSON: " + e.message);
      process.exit(1);
    }
    if (o.ok !== false || !o.error || typeof o.error.code !== "string") {
      console.error("bogus: not a JSON error envelope: " + s);
      process.exit(1);
    }
  });
' || {
  echo "pack-smoke: FAIL — bogus subcommand stdout is not a JSON error envelope" >&2
  exit 1
}
echo "pack-smoke: bogus subcommand -> exit 2, JSON error envelope (ok)"

# 4) The post-update skills self-heal, through the SHIPPED artifact. Unit tests
# inject a resync seam, so they cannot catch a missing split chunk, a broken
# dynamic import, packaged-skill resolution failing outside the source tree, or a
# dropped dispatcher call. This seeds a machine that installed on an older
# version and asserts the packaged bytes land, without disturbing the triggering
# command's envelope or exit code.
SYNC_HOME="$(mktemp -d)"
SYNC_DATA="$(mktemp -d)"
trap 'cleanup; rm -rf "$SYNC_HOME" "$SYNC_DATA"' EXIT

WIRED_DIR="$SYNC_HOME/.claude/skills"
mkdir -p "$WIRED_DIR/tenjin-search"
printf 'stale copy from an older release\n' > "$WIRED_DIR/tenjin-search/SKILL.md"
# An old version, and this directory recorded as the one install consented to.
node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    schemaVersion: 1,
    cliVersion: "0.0.0-old",
    dirs: [process.argv[2]],
  }, null, 2) + "\n");
' "$SYNC_DATA/skills-sync.json" "$WIRED_DIR"

set +e
SYNC_OUT="$(HOME="$SYNC_HOME" TENJIN_DATA_DIR="$SYNC_DATA" "$BIN" candidate list --json 2>/dev/null)"
SYNC_CODE=$?
set -e
if [ "$SYNC_CODE" -ne 0 ]; then
  echo "pack-smoke: FAIL — 'candidate list' exited $SYNC_CODE during self-heal, expected 0" >&2
  echo "$SYNC_OUT" >&2
  exit 1
fi
printf '%s' "$SYNC_OUT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let o;
    try {
      o = JSON.parse(s);
    } catch (e) {
      console.error("self-heal: stdout is not JSON: " + e.message);
      process.exit(1);
    }
    if (o.schemaVersion === undefined || o.command !== "candidate.list" || o.ok !== true) {
      console.error("self-heal: unexpected envelope: " + s);
      process.exit(1);
    }
  });
' || {
  echo "pack-smoke: FAIL — the self-heal disturbed the triggering command's envelope" >&2
  exit 1
}

# The packaged skill is inside the installed package, so compare against it.
PACKED_SKILL="$CONSUMER_DIR/node_modules/tenjin-cli/skills/tenjin-search/SKILL.md"
[ -f "$PACKED_SKILL" ] || {
  echo "pack-smoke: FAIL — installed package ships no tenjin-search skill" >&2
  exit 1
}
if ! cmp -s "$PACKED_SKILL" "$WIRED_DIR/tenjin-search/SKILL.md"; then
  echo "pack-smoke: FAIL — self-heal did not refresh the wired skill to the packaged copy" >&2
  diff "$PACKED_SKILL" "$WIRED_DIR/tenjin-search/SKILL.md" | head -20 >&2
  exit 1
fi
# The other shipped skills land too, and the stamp moves to the running version.
[ -f "$WIRED_DIR/tenjin-publish/SKILL.md" ] || {
  echo "pack-smoke: FAIL — self-heal left tenjin-publish unwired" >&2
  exit 1
}
STAMPED="$(node -e 'console.log(require(process.argv[1]).cliVersion)' "$SYNC_DATA/skills-sync.json")"
if [ "$STAMPED" != "$EXPECTED_VERSION" ]; then
  echo "pack-smoke: FAIL — stamp says '$STAMPED', expected '$EXPECTED_VERSION'" >&2
  exit 1
fi
echo "pack-smoke: skills self-heal -> packaged bytes landed, stamp -> $STAMPED (ok)"

echo "pack-smoke: PASS (tenjin-cli@$EXPECTED_VERSION packed, installed, and exercised)"
