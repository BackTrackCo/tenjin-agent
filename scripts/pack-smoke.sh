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
cleanup() { rm -rf "$PACK_DIR" "$CONSUMER_DIR" "$DATA_DIR"; }
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

# The signal contract, both lanes. Every step is asserted: the process must still
# be alive when signalled, the signal must be delivered, the exit must be the
# interrupted one, and the handler's own diagnostic must appear. Without those the
# lane can pass while exercising no handler at all, which is what an earlier
# version of this check did.

# Lane 1: a run QUEUED behind another install must never remove that install's lock.
# A fresh waiter per attempt, because the handler is registered inside the command
# after node boots and the walkthrough reaches the lock: signalling before that gives
# the DEFAULT action (exit 130, empty stderr), which is a missed attempt and not a
# failure. Only exhausting the attempts fails.
WAITER_OK=""
for attempt in 1 2 3 4 5; do
  LOCK_HOME="$(mktemp -d)"
  LOCK_DATA="$(mktemp -d)"
  mkdir -p "$LOCK_DATA/skills-sync.lock"
  HOME="$LOCK_HOME" TENJIN_DATA_DIR="$LOCK_DATA" "$BIN" install --harness claude \
    --publish-mode review --allow-free-verbs --no-wallet --json >/dev/null 2>"$LOCK_HOME/err" &
  WAITER_PID=$!
  sleep 1
  if kill -0 "$WAITER_PID" 2>/dev/null; then
    kill -INT "$WAITER_PID" 2>/dev/null || true
  fi
  set +e
  wait "$WAITER_PID"
  WAITER_CODE=$?
  set -e
  if [ "$WAITER_CODE" = "130" ] && grep -q "nothing changed" "$LOCK_HOME/err"; then
    if [ ! -d "$LOCK_DATA/skills-sync.lock" ]; then
      echo "pack-smoke: FAIL — an interrupted WAITING install removed the holder's lock" >&2
      rm -rf "$LOCK_HOME" "$LOCK_DATA"
      exit 1
    fi
    WAITER_OK="yes"
  fi
  rm -rf "$LOCK_HOME" "$LOCK_DATA"
  [ -n "$WAITER_OK" ] && break
done
if [ -z "$WAITER_OK" ]; then
  echo "pack-smoke: FAIL — queued install never reported an interrupted-before-writing run" >&2
  exit 1
fi
echo "pack-smoke: interrupted queued install leaves the holder's lock intact (ok)"

# Lane 2: an interrupt while this process HOLDS the lock must release it and say the
# machine may be half-written. The real critical section is milliseconds, so the
# packaged skill tree is padded to widen it; landing outside the window is still
# possible, so the scenario is retried and only a run where the handler provably
# fired counts. Never firing across every attempt is a failure, not a pass.
PAD="$CONSUMER_DIR/node_modules/tenjin-cli/skills/tenjin-search/pad"
mkdir -p "$PAD"
i=0
while [ "$i" -lt 6000 ]; do printf 'x%.0s' $(seq 1 200) > "$PAD/f$i.md"; i=$((i + 1)); done
HELD_OK=""
for attempt in 1 2 3 4 5; do
  HOLD_HOME="$(mktemp -d)"
  HOLD_DATA="$(mktemp -d)"
  HOME="$HOLD_HOME" TENJIN_DATA_DIR="$HOLD_DATA" "$BIN" install --harness claude \
    --publish-mode review --allow-free-verbs --no-wallet --json >/dev/null 2>"$HOLD_HOME/err" &
  HOLDER_PID=$!
  for _ in $(seq 1 600); do
    [ -d "$HOLD_DATA/skills-sync.lock" ] && break
    sleep 0.01
  done
  sleep 0.25
  # Guarded: under `set -e` an unguarded kill aborts the whole script when the
  # padded install happened to finish first, which is a missed attempt rather than
  # a failure. Retry those; only exhausting every attempt fails.
  if ! kill -0 "$HOLDER_PID" 2>/dev/null; then
    wait "$HOLDER_PID" 2>/dev/null || true
    rm -rf "$HOLD_HOME" "$HOLD_DATA"
    continue
  fi
  kill -INT "$HOLDER_PID" 2>/dev/null || true
  set +e
  wait "$HOLDER_PID"
  HOLDER_CODE=$?
  set -e
  if [ "$HOLDER_CODE" = "130" ] && grep -q "half-written" "$HOLD_HOME/err"; then
    if [ -d "$HOLD_DATA/skills-sync.lock" ]; then
      echo "pack-smoke: FAIL — interrupted holding install left its own lock behind" >&2
      rm -rf "$HOLD_HOME" "$HOLD_DATA" "$PAD"
      exit 1
    fi
    HELD_OK="yes"
  fi
  rm -rf "$HOLD_HOME" "$HOLD_DATA"
  [ -n "$HELD_OK" ] && break
done
rm -rf "$PAD"
if [ -z "$HELD_OK" ]; then
  echo "pack-smoke: FAIL — never landed an interrupt inside the write; handler unproven" >&2
  exit 1
fi
echo "pack-smoke: interrupted holding install releases its own lock (ok)"

echo "pack-smoke: PASS (tenjin-cli@$EXPECTED_VERSION packed, installed, and exercised)"
