#!/bin/sh
set -eu

CLI_VERSION='@CLI_VERSION@'
CLI_SHA512='@CLI_SHA512@'
NODE_VERSION='@NODE_VERSION@'

fail() { printf 'Tenjin could not be installed: %s\nRetry the install after fixing this. Your existing setup was kept.\n' "$1" >&2; exit 1; }
[ -n "${HOME:-}" ] || fail 'HOME is not set.'
if [ -n "${TENJIN_DATA_DIR:-}" ] && [ "$TENJIN_DATA_DIR" != "$HOME/.tenjin" ]; then
  fail 'Plugin installation needs the default data directory. Run without TENJIN_DATA_DIR.'
fi
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)
    os=linux
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    case "$glibc" in 'glibc '*) glibc=${glibc#glibc } ;; *) fail 'Linux needs glibc 2.28 or newer; musl/Alpine is unsupported.' ;; esac
    major=${glibc%%.*}; minor=${glibc#*.}; minor=${minor%%.*}
    [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 28 ]; } || fail 'Linux needs glibc 2.28 or newer.'
    ;;
  *) fail 'This platform is unsupported. Use macOS, Windows or glibc Linux on x64/arm64.' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail 'This architecture is unsupported. Tenjin supports x64 and arm64.' ;;
esac
key=$os-$arch
case "$key" in
@NODE_CHECKSUM_CASES@
  *) fail 'No pinned Node download exists for this platform.' ;;
esac
for command in curl tar mktemp; do command -v "$command" >/dev/null 2>&1 || fail "The system needs $command."; done
if command -v sha256sum >/dev/null 2>&1 && command -v sha512sum >/dev/null 2>&1; then
  digest() { if [ "$1" = 256 ]; then sha256sum "$2"; else sha512sum "$2"; fi | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a "$1" "$2" | awk '{print $1}'; }
else
  fail 'The system needs shasum or sha256sum and sha512sum.'
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/tenjin-install.XXXXXXXX") || fail 'Could not create a temporary folder.'
trap 'rm -rf "$stage"' EXIT HUP INT TERM
fetch() {
  HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}" curl -q --proto '=https' --proto-redir '=https' --fail --location --silent --show-error --connect-timeout 30 --max-time 300 "$1" -o "$2" || fail 'A download failed. Check your connection or proxy settings.'
}
printf 'Installing Tenjin %s…\n' "$CLI_VERSION" >&2
archive="node-v$NODE_VERSION-$key"
fetch "https://nodejs.org/dist/v$NODE_VERSION/$archive.tar.gz" "$stage/node.tar.gz"
[ "$(digest 256 "$stage/node.tar.gz")" = "$node_sha" ] || fail 'The Node download did not match its checksum.'
mkdir "$stage/node" "$stage/cli"
tar -xzf "$stage/node.tar.gz" -C "$stage/node" --strip-components=1 "$archive/bin/node" || fail 'Could not unpack Node.'
node="$stage/node/bin/node"
[ "$("$node" -p process.version)" = "v$NODE_VERSION" ] || fail 'The downloaded Node cannot run on this system.'
fetch "https://registry.npmjs.org/tenjin-cli/-/tenjin-cli-$CLI_VERSION.tgz" "$stage/cli.tgz"
[ "$(digest 512 "$stage/cli.tgz")" = "$CLI_SHA512" ] || fail 'The Tenjin download did not match its checksum.'
tar -xzf "$stage/cli.tgz" -C "$stage/cli" --strip-components=1 || fail 'Could not unpack Tenjin.'
TENJIN_BOOTSTRAP_NODE_ARCHIVE="$stage/node.tar.gz" "$node" "$stage/cli/dist/index.js" install "$@"
