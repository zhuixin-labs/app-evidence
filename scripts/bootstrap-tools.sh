#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="${APPTRACE_WORKSPACE_ROOT:-$ROOT/.apptrace/default}"
TOOLS="${APPTRACE_TOOLS_DIR:-$WORKSPACE_ROOT/tools}"
DOWNLOADS="${APPTRACE_DOWNLOADS_DIR:-$TOOLS/downloads}"
mkdir -p "$DOWNLOADS" "$TOOLS"

# GitHub Release assets are often slow or unreachable from mainland China.
# The mirror only changes transport; the official SHA-256 below is still enforced.
GITHUB_MIRROR="${GITHUB_MIRROR:-https://gh-proxy.com/}"

say() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sha256() {
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download() {
  local url="$1"
  local dest="$2"
  if [ -s "$dest" ]; then
    printf 'cached: %s\n' "$dest"
    return 0
  fi

  local candidates=("$url")
  if [ -n "$GITHUB_MIRROR" ]; then
    case "$url" in
      https://github.com/*)
        candidates=("$GITHUB_MIRROR$url" "$url")
        ;;
    esac
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    printf 'download: %s\n' "$candidate"
    if curl -L --fail --silent --show-error --retry 3 --connect-timeout 20 \
      --max-time 900 -o "$dest.part" "$candidate"; then
      mv "$dest.part" "$dest"
      printf 'saved: %s (%s bytes)\n' "$dest" "$(wc -c < "$dest" | tr -d ' ')"
      return 0
    fi
    rm -f "$dest.part"
  done
  fail "download failed for all URLs: $url"
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(sha256 "$file")"
  if [ "$actual" != "$expected" ]; then
    fail "SHA-256 mismatch for $file: expected $expected, got $actual"
  fi
  printf 'sha256 ok: %s\n' "$(basename "$file")"
}

# ---------------------------------------------------------------------------
# Ghidra 12.1.4
# ---------------------------------------------------------------------------
GHIDRA_ZIP="$DOWNLOADS/ghidra_12.1.4_PUBLIC_20260921.zip"
GHIDRA_SHA256="ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db"
GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip"

say "Ghidra 12.1.4"
download "$GHIDRA_URL" "$GHIDRA_ZIP"
verify_sha256 "$GHIDRA_ZIP" "$GHIDRA_SHA256"
if [ ! -d "$TOOLS/ghidra_12.1.4_PUBLIC" ]; then
  say "Extracting Ghidra"
  unzip -q "$GHIDRA_ZIP" -d "$TOOLS"
fi

if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  say "Ghidra macOS arm64 natives"
  APPTRACE_TOOLS_DIR="$TOOLS" APPTRACE_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    "$ROOT/scripts/build-ghidra-arm64.sh"
fi

# ---------------------------------------------------------------------------
# Temurin JDK 21 for macOS arm64
# ---------------------------------------------------------------------------
JDK_JSON="$DOWNLOADS/adoptium-jdk21-mac-aarch64.json"
JDK_API="https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&image_type=jdk&os=mac&vendor=eclipse"

say "Temurin JDK 21 (macOS arm64)"
download "$JDK_API" "$JDK_JSON"

JDK_LINE="$(python3 - "$JDK_JSON" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    assets = json.load(handle)
if not assets:
    raise SystemExit("Adoptium returned no assets")
package = assets[0]["binary"]["package"]
print(package["name"])
print(package["checksum"])
print(package["link"])
PY
)"

JDK_NAME="$(printf '%s\n' "$JDK_LINE" | sed -n '1p')"
JDK_SHA256="$(printf '%s\n' "$JDK_LINE" | sed -n '2p')"
JDK_URL="$(printf '%s\n' "$JDK_LINE" | sed -n '3p')"
[ -n "$JDK_NAME" ] && [ -n "$JDK_SHA256" ] && [ -n "$JDK_URL" ] || \
  fail "Unable to parse Adoptium metadata"

JDK_TGZ="$DOWNLOADS/$JDK_NAME"
download "$JDK_URL" "$JDK_TGZ"
verify_sha256 "$JDK_TGZ" "$JDK_SHA256"

if [ ! -x "$TOOLS/jdk/bin/java" ]; then
  say "Extracting JDK"
  rm -rf "$TOOLS/jdk.tmp"
  mkdir -p "$TOOLS/jdk.tmp"
  LC_ALL=C tar -xzf "$JDK_TGZ" -C "$TOOLS/jdk.tmp"
  JDK_HOME="$(find "$TOOLS/jdk.tmp" -type f -path '*/Contents/Home/bin/java' -print | sed -n '1p' | sed 's#/bin/java$##')"
  [ -n "$JDK_HOME" ] || fail "JDK Contents/Home not found in archive"
  rm -rf "$TOOLS/jdk"
  mv "$JDK_HOME" "$TOOLS/jdk"
  rm -rf "$TOOLS/jdk.tmp"
fi

# ---------------------------------------------------------------------------
# ipatool 2.7.0 for macOS arm64
# ---------------------------------------------------------------------------
IPATOOL_TGZ="$DOWNLOADS/ipatool-2.7.0-macos-arm64.tar.gz"
IPATOOL_URL="https://github.com/majd/ipatool/releases/download/v2.7.0/ipatool-2.7.0-macos-arm64.tar.gz"
IPATOOL_SHA256="5ae100d4520cf4b3f4374239e5925a9ad9a8dc02abc16bae27479e7ae99aca33"

say "ipatool 2.7.0 (macOS arm64)"
download "$IPATOOL_URL" "$IPATOOL_TGZ"
verify_sha256 "$IPATOOL_TGZ" "$IPATOOL_SHA256"

if [ ! -x "$TOOLS/ipatool/bin/ipatool" ]; then
  say "Extracting ipatool"
  rm -rf "$TOOLS/ipatool"
  mkdir -p "$TOOLS/ipatool"
  LC_ALL=C tar -xzf "$IPATOOL_TGZ" -C "$TOOLS/ipatool"
  IPATOOL_BIN="$(find "$TOOLS/ipatool" -type f -perm -111 -name 'ipatool*' -print | sed -n '1p')"
  [ -n "$IPATOOL_BIN" ] || fail "ipatool binary not found after extraction"
  mkdir -p "$TOOLS/ipatool/bin"
  ln -sf "$(basename "$IPATOOL_BIN")" "$TOOLS/ipatool/bin/ipatool"
  xattr -dr com.apple.quarantine "$TOOLS/ipatool" 2>/dev/null || true
  codesign --force --sign - "$IPATOOL_BIN" 2>/dev/null || true
fi

say "Installed versions"
"$TOOLS/jdk/bin/java" -version
"$TOOLS/ipatool/bin/ipatool" --version || true
printf 'Ghidra: %s\n' "$TOOLS/ghidra_12.1.4_PUBLIC"
printf 'JDK:    %s\n' "$TOOLS/jdk"
printf 'ipatool:%s\n' "$TOOLS/ipatool/bin/ipatool"
