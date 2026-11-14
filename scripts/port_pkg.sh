#!/usr/bin/env bash
# Copy one package directory from rocket at the pinned commit and apply the
# rename table. Reads the commit, never rocket's working tree.
set -euo pipefail
ROCKET="${ROCKET_REPO:-$HOME/projects/rocket}"
COMMIT=4f6f383
pkg="${1:?usage: port_pkg.sh <path-under-internal>}"
dst="internal/$pkg"
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
echo "ported internal/$pkg from rocket@$COMMIT"
