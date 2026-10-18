#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="${APPTRACE_TOOLS_DIR:-$ROOT/.apptrace/default/tools}"
GHIDRA="$TOOLS/ghidra_12.1.4_PUBLIC"
SRC="$GHIDRA/Ghidra/Features/Decompiler/src/decompile/cpp"
OUT="$GHIDRA/Ghidra/Features/Decompiler/os/mac_arm_64"
LOG="$TOOLS/build-ghidra-arm64.log"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "This builder targets macOS arm64; current host is $(uname -s)/$(uname -m)." >&2
  exit 1
fi

if [ -x "$OUT/decompile" ] && [ -x "$OUT/sleigh" ]; then
  echo "Ghidra mac_arm_64 natives already present: $OUT"
  exit 0
fi

if [ ! -d "$SRC" ]; then
  echo "Ghidra source tree not found: $SRC" >&2
  echo "Run ./scripts/bootstrap-download.sh first." >&2
  exit 1
fi

if ! command -v clang++ >/dev/null 2>&1; then
  echo "clang++ not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$OUT" "$TOOLS"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 8)"

echo "Building Ghidra 12.1.4 native decompiler for macOS arm64 (jobs=$JOBS)..."
make -C "$SRC" -j"$JOBS" ghidra_opt sleigh_opt \
  OS=Darwin \
  ARCH_TYPE='-arch arm64' \
  ADDITIONAL_FLAGS='-mmacosx-version-min=11.0 -w' \
  OSDIR=mac_arm_64 \
  CXX='clang++ -std=c++11' >"$LOG" 2>&1

cp "$SRC/ghidra_opt" "$OUT/decompile"
cp "$SRC/sleigh_opt" "$OUT/sleigh"
chmod +x "$OUT/decompile" "$OUT/sleigh"

echo "Installed:"
file "$OUT/decompile" "$OUT/sleigh"
