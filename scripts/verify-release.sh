#!/usr/bin/env bash
# Verify a release the way a user receives it.
#
#   ./scripts/verify-release.sh              # install the published version from npm
#   ./scripts/verify-release.sh --tarballs   # build, pack, install the tarballs
#   ./scripts/verify-release.sh --analyze https://apps.apple.com/cn/app/id1616124777
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

source_kind="registry"
if [[ "${1:-}" == "--tarballs" ]]; then
  source_kind="tarballs"
  shift
  pnpm build
fi

exec node scripts/release-smoke.mjs --source "$source_kind" "$@"
