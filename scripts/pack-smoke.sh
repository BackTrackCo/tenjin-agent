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
# directory does not matter. Every CLI invocation points TENJIN_DATA_DIR inside a
# fresh temp dir — never the runner's real ~/.tenjin. The heal legs point it at
# their sandbox HOME's OWN default (`$HOME/.tenjin`) rather than at a separate
# temp dir, because the heal stands down on a redirected data dir.
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

# The MCP Registry's npm validator fetches the pinned version from npm and requires
# its package.json mcpName to equal the server name. Dropping the field breaks
# BackTrackCo/tenjin's NEXT registry publish, weeks later and nowhere near here,
# so assert it on the packed artifact the validator would actually read.
MCP_NAME="$(node -e "process.stdout.write(require('./node_modules/tenjin-cli/package.json').mcpName ?? '')")"
[ "$MCP_NAME" = "blog.tenjin/tenjin" ] || {
  echo "pack-smoke: FAIL, packed mcpName is '$MCP_NAME', expected 'blog.tenjin/tenjin'" >&2
  exit 1
}

# 1) --version prints exactly the package.json version.
GOT_VERSION="$("$BIN" --version)"
if [ "$GOT_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "pack-smoke: FAIL — --version printed '$GOT_VERSION', expected '$EXPECTED_VERSION'" >&2
  exit 1
fi
echo "pack-smoke: --version -> $GOT_VERSION (ok)"

# The `node:sqlite` check that used to sit here proved tsup kept the `node:`
# prefix by opening the loop store through the packed doctor. That store is the
# shelf's and this release registers nothing that reads it, so the same
# invariant is proved by 1c instead: the packed worker is loaded by URL and
# imports `node:worker_threads`, so a stripped prefix fails there too.

# 1c) The keystore KDF worker, by its RUNTIME PATH. `keystore-kdf.ts` resolves
# `./wallet-kdf-worker.mjs` beside its own chunk and hands it to `new Worker`,
# so a `files` entry or a tsup block that stopped emitting it would leave every
# wallet unlock throwing at the first signature, with every source-tree test
# green. Asserted on behaviour: the packed worker derives a key from a keystore
# on stdin-free workerData and returns the hex the parent expects.
[ -f "./node_modules/tenjin-cli/dist/wallet-kdf-worker.mjs" ] || {
  echo "pack-smoke: FAIL — dist/wallet-kdf-worker.mjs missing from the installed package" >&2
  exit 1
}
# A PBKDF2 keystore and the key it derives, both fixed: the consumer sandbox has
# no `ox` of its own, and the worker bundles the one that matters. A wrong key
# here means the packed worker is not the KDF the wallet was encrypted with.
KDF_KEYSTORE='{"crypto": {"cipher": "aes-128-ctr", "ciphertext": "908d830584a9ece93fa07b7e900423a136c9f0eb101ec884f9f7ed4198df5a05", "cipherparams": {"iv": "03030303030303030303030303030303"}, "kdf": "pbkdf2", "kdfparams": {"c": 1024, "dklen": 32, "prf": "hmac-sha256", "salt": "0707070707070707070707070707070707070707070707070707070707070707"}, "mac": "d16c240f4b901d3daf5a81af7835a7c600bddbde1cf3ad82e7ca0369acf167dc"}, "id": "fd2890d5-c26b-4333-8449-f948ad996e62", "version": 3}'
KDF_EXPECTED='0x824d7d885002e6070efafa3288922e189ffee45189abc699b2f4eb10cb83e565'
KDF_KEYSTORE="$KDF_KEYSTORE" KDF_EXPECTED="$KDF_EXPECTED" node --input-type=module -e '
  import { Worker } from "node:worker_threads";
  const keystore = JSON.parse(process.env.KDF_KEYSTORE);
  const url = new URL("./node_modules/tenjin-cli/dist/wallet-kdf-worker.mjs", import.meta.url);
  const worker = new Worker(url, { workerData: { keystore, password: "pack smoke" }, execArgv: [] });
  const message = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("worker exited with no result")));
  });
  await worker.terminate();
  if (message.key !== process.env.KDF_EXPECTED) {
    throw new Error("the packed worker derived " + JSON.stringify(message) + ", expected " + process.env.KDF_EXPECTED);
  }
' || {
  echo "pack-smoke: FAIL — the packed keystore worker did not derive its key" >&2
  exit 1
}
echo "pack-smoke: packed wallet-kdf-worker.mjs derives the expected key (ok)"

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

# The skills the shelf product shipped, and the self-heal that rewrote them, are
# gone from `files`: this release registers no command that reads them. Their
# checks go with them rather than asserting over an empty directory.

# The two interrupt lanes that used to live here drove the shelf install's own
# guard through `--harness` and `--publish-mode`, flags this release's install
# does not have. The router install holds the config lock only inside the same
# locked merge-write every `config set` uses, which `src/lib/lock.ts` covers.

echo "pack-smoke: PASS (tenjin-cli@$EXPECTED_VERSION packed, installed, and exercised)"
