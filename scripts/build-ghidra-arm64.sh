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
  echo "Re-run: apptrace setup --install" >&2
  exit 1
fi

for tool in clang++ make; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool not found. Install Xcode Command Line Tools: xcode-select --install" >&2
    exit 1
  fi
done

mkdir -p "$OUT" "$TOOLS"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 8)"

echo "Building Ghidra 12.1.4 native decompiler for macOS arm64 (jobs=$JOBS)."
echo "This compiles Ghidra's C++ decompiler; expect a few minutes."
echo "Log: $LOG"
: >"$LOG"

# Two separate make runs on purpose. The decompiler Makefile picks its dependency
# set from MAKECMDGOALS: `ghidra_opt sleigh_opt` together falls through to the
# combined com_* set, which also builds loadimage_bfd.cc and then requires
# binutils' bfd.h. Each target alone selects ghi_opt/sla_opt and needs no libbfd.
build_target() {
  local target="$1"
  echo "make $target" >>"$LOG"
  make -C "$SRC" -j"$JOBS" "$target" \
    OS=Darwin \
    ARCH_TYPE='-arch arm64' \
    ADDITIONAL_FLAGS='-mmacosx-version-min=11.0 -w' \
    OSDIR=mac_arm_64 \
    CXX='clang++ -std=c++11' >>"$LOG" 2>&1
}

if ! build_target ghidra_opt; then
  echo "Decompiler build failed (ghidra_opt). Last 20 log lines:" >&2
  tail -n 20 "$LOG" >&2
  exit 1
fi
if ! build_target sleigh_opt; then
  echo "Decompiler build failed (sleigh_opt). Last 20 log lines:" >&2
  tail -n 20 "$LOG" >&2
  exit 1
fi

cp "$SRC/ghidra_opt" "$OUT/decompile"
cp "$SRC/sleigh_opt" "$OUT/sleigh"
chmod +x "$OUT/decompile" "$OUT/sleigh"

echo "Installed:"
file "$OUT/decompile" "$OUT/sleigh"
