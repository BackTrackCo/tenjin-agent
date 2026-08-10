#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_NAME="tenjin-cli"
TENJIN_VERSION="${TENJIN_VERSION:-latest}"
INSTALL_PREFIX="${TENJIN_INSTALL_PREFIX:-}"
HARNESSES=()
AUTO_HARNESS=0

log() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Install Tenjin and wire one or more supported agent harnesses.

Usage:
  install.sh [--harness auto|claude|codex|hermes|shared]...
             [--version <npm-version>]
             [--prefix <absolute-path>]

Examples:
  # Detect installed harnesses; never create a wallet implicitly
  curl -fsSL https://raw.githubusercontent.com/BackTrackCo/tenjin-agent/main/scripts/install.sh | bash

  # One installer, multiple explicit targets
  curl -fsSL https://raw.githubusercontent.com/BackTrackCo/tenjin-agent/main/scripts/install.sh |
    bash -s -- --harness claude --harness codex

Environment:
  TENJIN_VERSION         npm version/tag to install (default: latest)
  TENJIN_INSTALL_PREFIX  npm prefix to use instead of the detected global prefix
EOF
}

need_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "$flag needs a value."
}

add_harness() {
  local harness="$1"
  case "$harness" in
    auto)
      [[ "${#HARNESSES[@]}" -eq 0 ]] || die "--harness auto cannot be combined with explicit harnesses."
      AUTO_HARNESS=1
      ;;
    claude|codex|hermes|shared)
      [[ "$AUTO_HARNESS" -eq 0 ]] || die "--harness auto cannot be combined with explicit harnesses."
      if [[ "${#HARNESSES[@]}" -gt 0 ]]; then
        for existing in "${HARNESSES[@]}"; do
          [[ "$existing" != "auto" ]] || die "--harness auto cannot be combined with explicit harnesses."
          [[ "$existing" != "$harness" ]] || return 0
        done
      fi
      HARNESSES+=("$harness")
      ;;
    openclaw)
      die "$harness installation is deferred and not available in the current CLI. No wallet was changed."
      ;;
    *)
      die "Unsupported harness: $harness. Use auto, claude, codex, hermes, or shared."
      ;;
  esac
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --harness)
      need_value "$1" "${2:-}"
      add_harness "$2"
      shift 2
      ;;
    --version)
      need_value "$1" "${2:-}"
      TENJIN_VERSION="$2"
      shift 2
      ;;
    --prefix)
      need_value "$1" "${2:-}"
      INSTALL_PREFIX="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1. Run with --help for usage."
      ;;
  esac
done

[[ "$TENJIN_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] ||
  die "Invalid Tenjin version/tag: $TENJIN_VERSION"
[[ "${HOME:-}" == /* && "$HOME" != "/" ]] ||
  die "HOME must be an absolute user directory other than /."

case "$(uname -s 2>/dev/null || true)" in
  Darwin|Linux) ;;
  *) die "This installer currently supports macOS, Linux, and WSL. Use npm on other platforms: npm install -g tenjin-cli" ;;
esac

have node || die "Node.js 22+ is required. Install it from https://nodejs.org, then rerun."
have npm || die "npm is required. Install Node.js 22+ from https://nodejs.org, then rerun."

NODE_VERSION="$(node --version 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] ||
  die "Node.js 22+ is required; found ${NODE_VERSION:-unknown}."

if [[ -z "$INSTALL_PREFIX" ]]; then
  GLOBAL_PREFIX="$(npm prefix --global 2>/dev/null || true)"
  if [[ "$GLOBAL_PREFIX" == /* && "$GLOBAL_PREFIX" != "/" && -w "$GLOBAL_PREFIX" ]]; then
    INSTALL_PREFIX="$GLOBAL_PREFIX"
  else
    INSTALL_PREFIX="$HOME/.local"
  fi
fi

[[ "$INSTALL_PREFIX" == /* && "$INSTALL_PREFIX" != "/" ]] ||
  die "The install prefix must be an absolute path other than /: $INSTALL_PREFIX"
mkdir -p "$INSTALL_PREFIX"

PACKAGE_SPEC="$PACKAGE_NAME@$TENJIN_VERSION"
log "== Tenjin installer =="
log "Installing $PACKAGE_SPEC under $INSTALL_PREFIX"
npm install --global --prefix "$INSTALL_PREFIX" "$PACKAGE_SPEC"

TENJIN_BIN="$INSTALL_PREFIX/bin/tenjin"
[[ -x "$TENJIN_BIN" ]] || die "npm completed but did not install an executable at $TENJIN_BIN"

INSTALL_ARGS=(install)
if [[ "${#HARNESSES[@]}" -gt 0 ]]; then
  for harness in "${HARNESSES[@]}"; do
    [[ "$harness" == "auto" ]] || INSTALL_ARGS+=(--harness "$harness")
  done
fi
# A curl-piped script has no safe wallet-consent channel. Wallet creation stays
# a separate explicit step after the package and harness wiring are installed.
INSTALL_ARGS+=(--no-wallet)

PATH="$INSTALL_PREFIX/bin:$PATH" "$TENJIN_BIN" "${INSTALL_ARGS[@]}"

case ":$PATH:" in
  *":$INSTALL_PREFIX/bin:"*) ;;
  *)
    warn "$INSTALL_PREFIX/bin is not on PATH. Add this line to your shell profile before restarting your agent:"
    warn "export PATH=\"$INSTALL_PREFIX/bin:\$PATH\""
    ;;
esac

log "Installed Tenjin $($TENJIN_BIN --version)."
log "No wallet was created. Create one explicitly later with:"
log "  tenjin wallet create"
