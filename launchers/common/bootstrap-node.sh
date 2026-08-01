#!/usr/bin/env sh
set -eu

repo_root=${1:?repository root is required}
entrypoint="$repo_root/scripts/one-click-onboarding.mjs"
tool_root="$repo_root/.product-ops-tools"

node_is_usable() {
  command -v "$1" >/dev/null 2>&1 || return 1
  major=$($1 -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')
  [ "$major" -ge 20 ]
}

if node_is_usable node; then
  exec node "$entrypoint"
fi

system_name=$(uname -s)
case "$system_name" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) printf '%s\n' "Unsupported operating system: $system_name" >&2; exit 2 ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) architecture=x64 ;;
  arm64|aarch64) architecture=arm64 ;;
  *) printf '%s\n' "Unsupported architecture: $machine" >&2; exit 2 ;;
esac

mkdir -p "$tool_root"
for candidate in "$tool_root"/node-v*-${platform}-${architecture}/bin/node; do
  if [ -x "$candidate" ] && node_is_usable "$candidate"; then
    PATH="$(dirname "$candidate"):$PATH"
    export PATH
    exec "$candidate" "$entrypoint"
  fi
done

if command -v curl >/dev/null 2>&1; then
  fetch() { curl --fail --location --silent --show-error "$1" --output "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
else
  printf '%s\n' "curl or wget is required to download the portable Node.js runtime." >&2
  exit 2
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/open-product-ops-node.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
base_url="https://nodejs.org/dist/latest-v22.x"
checksums="$temporary/SHASUMS256.txt"
fetch "$base_url/SHASUMS256.txt" "$checksums"
suffix="-${platform}-${architecture}.tar.gz"
archive=$(awk -v suffix="$suffix" 'index($2,suffix)==length($2)-length(suffix)+1 {print $2; exit}' "$checksums")
expected=$(awk -v name="$archive" '$2==name {print $1; exit}' "$checksums")
[ -n "$archive" ] && [ -n "$expected" ] || { printf '%s\n' "Portable runtime archive was not listed by nodejs.org." >&2; exit 2; }
archive_path="$temporary/$archive"
printf '%s\n' "Downloading verified portable Node.js runtime…"
fetch "$base_url/$archive" "$archive_path"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive_path" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$archive_path" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || { printf '%s\n' "Portable runtime checksum verification failed." >&2; exit 2; }
tar -xzf "$archive_path" -C "$tool_root"
runtime_directory=${archive%.tar.gz}
node_path="$tool_root/$runtime_directory/bin/node"
[ -x "$node_path" ] || { printf '%s\n' "Portable runtime extraction failed." >&2; exit 2; }
PATH="$(dirname "$node_path"):$PATH"
export PATH
exec "$node_path" "$entrypoint"
