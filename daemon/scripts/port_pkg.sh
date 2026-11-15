#!/usr/bin/env bash
# Copy one package directory from rocket at the pinned commit and apply the
# rename table. Reads the commit, never rocket's working tree.
set -euo pipefail
ROCKET="${ROCKET_REPO:-$HOME/projects/rocket}"
COMMIT=4f6f383
pkg="${1:?usage: port_pkg.sh <path-under-internal>}"
# The destination is the module's internal/ next to this script's folder
# (daemon/internal), so the script works from any current directory.
module_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dst="$module_dir/internal/$pkg"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git -C "$ROCKET" archive "$COMMIT" "internal/$pkg" | tar -x -C "$tmp"
mkdir -p "$dst"
find "$tmp/internal/$pkg" -maxdepth 1 -type f -exec cp {} "$dst/" \;
[ -d "$tmp/internal/$pkg/testdata" ] && cp -R "$tmp/internal/$pkg/testdata" "$dst/"
find "$dst" -maxdepth 1 -type f \( -name '*.go' -o -name '*.sh' -o -name '*.ts' -o -name '*.js' \) -print0 |
  xargs -0 perl -pi -e '
    s{github\.com/IvanRoslov/rocket/}{github.com/IvanRoslov/hopp/}g;
    s{ROCKET_}{HOPP_}g; s{RocketSessionID}{HoppSessionID}g;
    s{rocketd-}{hoppd-}g; s{\.rocket/}{.hopp/}g; s{\.rocket-prompt\.md}{.hopp-prompt.md}g;
    s{rocket-(launch\.sh|inject-|tmp-|pi-|lock|managed)}{hopp-$1}g;'
# Renames change identifier lengths, which breaks gofmt column alignment.
find "$dst" -maxdepth 1 -type f -name '*.go' -print0 | xargs -0 gofmt -w
echo "ported $dst from rocket@$COMMIT"
