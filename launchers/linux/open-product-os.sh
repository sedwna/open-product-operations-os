#!/bin/sh
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$launcher_dir/../.." && pwd)
exec sh "$repo_root/launchers/common/bootstrap-node.sh" "$repo_root"
