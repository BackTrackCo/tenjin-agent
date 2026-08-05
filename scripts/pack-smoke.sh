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

# 4) The self-heal, from the PACKED skills. Only the published tarball can prove
# this: the heal reads skills/ out of the installed package, which is exactly what
# the `files` allowlist governs, and it refuses to run at all from a source
# checkout. `CI` is cleared for these runs because the heal skips a build machine,
# like the update nudge does.
#
# One run, four verdicts: a stale wired adapter is rewritten, and the three things
# an unattended writer must not touch are not — the hosted `tenjin` mirror (the
# copy on disk may be a newer fetch from tenjin.blog than this package ships), a
# SYMLINKED destination (following it would write wherever it points), and a
# same-named skill that is somebody else's by its frontmatter.
HEAL_HOME="$(mktemp -d)"
HEAL_DATA="$(mktemp -d)"
PACKED_SKILL="./node_modules/tenjin-cli/skills/tenjin-search/SKILL.md"
mkdir -p "$HEAL_HOME/.claude/skills/tenjin-search" "$HEAL_HOME/.claude/skills/tenjin" \
  "$HEAL_HOME/.claude/skills/tenjin-publish" "$HEAL_HOME/.agents/skills/tenjin-search"
printf -- '---\nname: tenjin-search\n---\n\nstale\n' \
  > "$HEAL_HOME/.claude/skills/tenjin-search/SKILL.md"
printf 'a newer fetch\n' > "$HEAL_HOME/.claude/skills/tenjin/SKILL.md"
# A VALID, stale tenjin-publish skill behind the link, which is the dotfiles setup
# this guards: anything else would be refused by the frontmatter gate instead, and
# the lstat gate would go untested.
printf -- '---\nname: tenjin-publish\n---\n\nstale\n' > "$HEAL_HOME/dotfiles-skill.md"
ln -s "$HEAL_HOME/dotfiles-skill.md" "$HEAL_HOME/.claude/skills/tenjin-publish/SKILL.md"
printf -- '---\nname: acme-search\n---\n' > "$HEAL_HOME/.agents/skills/tenjin-search/SKILL.md"

heal_fail() {
  echo "pack-smoke: FAIL — $1" >&2
  rm -rf "$HEAL_HOME" "$HEAL_DATA"
  exit 1
}

set +e
HEAL_OUT="$(HOME="$HEAL_HOME" TENJIN_DATA_DIR="$HEAL_DATA" CI= "$BIN" config --json 2>/dev/null)"
HEAL_CODE=$?
set -e
[ "$HEAL_CODE" -eq 0 ] || heal_fail "'tenjin config --json' exited $HEAL_CODE with the heal wired in"
# JSON.parse rejects a second object, so this is the exactly-one-envelope contract:
# the heal runs after it and must never add to stdout.
printf '%s' "$HEAL_OUT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let o;
    try {
      o = JSON.parse(s);
    } catch (e) {
      console.error("heal: stdout is not exactly one JSON object: " + e.message);
      process.exit(1);
    }
    if (o.ok !== true || o.command !== "config") {
      console.error("heal: unexpected envelope: " + s);
      process.exit(1);
    }
  });
' || heal_fail "the heal disturbed the one-JSON-object contract on stdout"

cmp -s "$HEAL_HOME/.claude/skills/tenjin-search/SKILL.md" "$PACKED_SKILL" ||
  heal_fail "a stale wired skill was not healed by an ordinary command"
[ "$(cat "$HEAL_HOME/.claude/skills/tenjin/SKILL.md")" = "a newer fetch" ] ||
  heal_fail "the heal overwrote the hosted tenjin mirror"
[ "$(cat "$HEAL_HOME/dotfiles-skill.md")" = "$(printf -- '---\nname: tenjin-publish\n---\n\nstale')" ] ||
  heal_fail "the heal wrote through a symlinked SKILL.md"
grep -q 'acme-search' "$HEAL_HOME/.agents/skills/tenjin-search/SKILL.md" ||
  heal_fail "the heal replaced a third-party skill sitting at one of our paths"
rm -rf "$HEAL_HOME" "$HEAL_DATA"
echo "pack-smoke: stale adapter healed; mirror, symlink and third-party skill untouched (ok)"

# 5) The heal's chunk is lazily imported, so a half-unpacked or corrupt install can
# make that import fail. It must stay invisible: the command has already emitted
# its envelope by then, and a rejection there would add a second one and a nonzero
# exit to a command that succeeded.
CHUNK_HOME="$(mktemp -d)"
CHUNK_DATA="$(mktemp -d)"
CHUNK_BACKUP="$(mktemp -d)"
mkdir -p "$CHUNK_HOME/.claude/skills/tenjin-search"
printf -- '---\nname: tenjin-search\n---\n\nstale\n' \
  > "$CHUNK_HOME/.claude/skills/tenjin-search/SKILL.md"
# Emitted as its own chunk by the dynamic import; the name is tsup's, from the
# module's own basename.
cp ./node_modules/tenjin-cli/dist/skill-heal-*.js "$CHUNK_BACKUP/" 2>/dev/null || {
  echo "pack-smoke: FAIL — no skill-heal chunk in the packed dist; did the lazy import go away?" >&2
  rm -rf "$CHUNK_HOME" "$CHUNK_DATA" "$CHUNK_BACKUP"
  exit 1
}
rm -f ./node_modules/tenjin-cli/dist/skill-heal-*.js
set +e
CHUNK_OUT="$(HOME="$CHUNK_HOME" TENJIN_DATA_DIR="$CHUNK_DATA" CI= "$BIN" config --json 2>/dev/null)"
CHUNK_CODE=$?
set -e
cp "$CHUNK_BACKUP"/skill-heal-*.js ./node_modules/tenjin-cli/dist/
if [ "$CHUNK_CODE" -ne 0 ]; then
  echo "pack-smoke: FAIL — a missing heal chunk changed the exit code to $CHUNK_CODE" >&2
  rm -rf "$CHUNK_HOME" "$CHUNK_DATA" "$CHUNK_BACKUP"
  exit 1
fi
printf '%s' "$CHUNK_OUT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      if (JSON.parse(s).ok !== true) throw new Error("envelope is not ok:true");
    } catch (e) {
      console.error("chunk: stdout is not exactly one successful envelope: " + e.message);
      process.exit(1);
    }
  });
' || {
  echo "pack-smoke: FAIL — a missing heal chunk broke the stdout envelope" >&2
  rm -rf "$CHUNK_HOME" "$CHUNK_DATA" "$CHUNK_BACKUP"
  exit 1
}
rm -rf "$CHUNK_HOME" "$CHUNK_DATA" "$CHUNK_BACKUP"
echo "pack-smoke: a missing heal chunk leaves the command's contract intact (ok)"

# The signal contract, both lanes. Every step is asserted: the process must still
# be alive when signalled, the signal must be delivered, the exit must be the
# interrupted one, and the handler's own diagnostic must appear. Without those the
# lane can pass while exercising no handler at all, which is what an earlier
# version of this check did.

# The lock both lanes use is the CONFIG lock: the skills write takes none (each
# shipped file lands by its own atomic rename), so what install still holds while
# it can be interrupted is the config lock behind `--publish-mode`.

# Lane 1: a run QUEUED behind another writer must never remove that writer's lock.
# A fresh waiter per attempt, because the handler is registered inside the command
# after node boots and the walkthrough reaches the lock: signalling before that gives
# the DEFAULT action (exit 130, empty stderr), which is a missed attempt and not a
# failure. Only exhausting the attempts fails.
WAITER_OK=""
for attempt in 1 2 3 4 5; do
  LOCK_HOME="$(mktemp -d)"
  LOCK_DATA="$(mktemp -d)"
  mkdir -p "$LOCK_DATA/config.json.lock"
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
  # This diagnostic pins the lock-free ordering: the skills are already on disk by
  # the time anything blocks on a lock, so a waiter reporting "nothing changed"
  # would mean the wiring had moved back behind the lock.
  if [ "$WAITER_CODE" = "130" ] && grep -q "after the skills were written" "$LOCK_HOME/err"; then
    if [ ! -d "$LOCK_DATA/config.json.lock" ]; then
      echo "pack-smoke: FAIL — an interrupted WAITING install removed the holder's lock" >&2
      rm -rf "$LOCK_HOME" "$LOCK_DATA"
      exit 1
    fi
    WAITER_OK="yes"
  fi
  # Kept across the rm below so exhausting every attempt can still show WHY: exit
  # code plus stderr distinguish a pre-handler exit (130, empty) from a wrong
  # diagnostic (130, other text) from a crash (non-130).
  WAITER_LAST="exit $WAITER_CODE, stderr: $(cat "$LOCK_HOME/err" 2>/dev/null || echo '<unreadable>')"
  rm -rf "$LOCK_HOME" "$LOCK_DATA"
  [ -n "$WAITER_OK" ] && break
done
if [ -z "$WAITER_OK" ]; then
  echo "pack-smoke: FAIL — queued install never reported an interrupted-before-writing run" >&2
  echo "pack-smoke: last attempt: $WAITER_LAST" >&2
  exit 1
fi
echo "pack-smoke: interrupted queued install leaves the holder's lock intact (ok)"

# Lane 2: an interrupt while this process HOLDS the lock must release it and say the
# machine may be half-written. The critical section is a read-merge-write of
# config.json, so a padded config widens it: the padding is unknown keys, which the
# config schema passes through untouched, and every byte is read, validated and
# written back inside the lock. Landing outside the window is still possible, so the
# scenario is retried and only a run where the handler provably fired counts. Never
# firing across every attempt is a failure, not a pass.
HELD_OK=""
for attempt in 1 2 3 4 5; do
  HOLD_HOME="$(mktemp -d)"
  HOLD_DATA="$(mktemp -d)"
  node -e '
    const fs = require("fs");
    const pad = {};
    for (let i = 0; i < 300000; i += 1) pad["pad" + i] = "x".repeat(20);
    fs.writeFileSync(process.argv[1] + "/config.json", JSON.stringify(pad));
  ' "$HOLD_DATA"
  HOME="$HOLD_HOME" TENJIN_DATA_DIR="$HOLD_DATA" "$BIN" install --harness claude \
    --publish-mode review --allow-free-verbs --no-wallet --json >/dev/null 2>"$HOLD_HOME/err" &
  HOLDER_PID=$!
  for _ in $(seq 1 600); do
    [ -d "$HOLD_DATA/config.json.lock" ] && break
    sleep 0.01
  done
  sleep 0.25
  # Guarded: under `set -e` an unguarded kill aborts the whole script when the
  # padded install happened to finish first, which is a missed attempt rather than
  # a failure. Retry those; only exhausting every attempt fails.
  if ! kill -0 "$HOLDER_PID" 2>/dev/null; then
    wait "$HOLDER_PID" 2>/dev/null || true
    HOLDER_LAST="install finished before the signal landed (window missed)"
    rm -rf "$HOLD_HOME" "$HOLD_DATA"
    continue
  fi
  kill -INT "$HOLDER_PID" 2>/dev/null || true
  set +e
  wait "$HOLDER_PID"
  HOLDER_CODE=$?
  set -e
  if [ "$HOLDER_CODE" = "130" ] && grep -q "half-written" "$HOLD_HOME/err"; then
    if [ -d "$HOLD_DATA/config.json.lock" ]; then
      echo "pack-smoke: FAIL — interrupted holding install left its own lock behind" >&2
      rm -rf "$HOLD_HOME" "$HOLD_DATA"
      exit 1
    fi
    HELD_OK="yes"
  fi
  # Same as the waiter lane: keep the evidence the rm below would destroy.
  HOLDER_LAST="exit $HOLDER_CODE, stderr: $(cat "$HOLD_HOME/err" 2>/dev/null || echo '<unreadable>')"
  rm -rf "$HOLD_HOME" "$HOLD_DATA"
  [ -n "$HELD_OK" ] && break
done
if [ -z "$HELD_OK" ]; then
  echo "pack-smoke: FAIL — never landed an interrupt inside the write; handler unproven" >&2
  echo "pack-smoke: last attempt: ${HOLDER_LAST:-no attempt ran}" >&2
  exit 1
fi
echo "pack-smoke: interrupted holding install releases its own lock (ok)"

echo "pack-smoke: PASS (tenjin-cli@$EXPECTED_VERSION packed, installed, and exercised)"
