#!/usr/bin/env sh
set -eu

repo_root=${1:?repository root is required}
shift
entrypoint="$repo_root/scripts/one-click-onboarding.mjs"
tool_root="$repo_root/.product-ops-tools"

node_is_usable() {
  command -v "$1" >/dev/null 2>&1 || return 1
  major=$($1 -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')
  [ "$major" -ge 20 ]
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

find_lock_file() {
  for candidate in "$repo_root/npm-shrinkwrap.json" "$repo_root/package-lock.json"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' 'A locked dependency file was not found beside package.json.' >&2
  return 1
}

dependencies_ready() {
  lock_file=$1
  marker="$tool_root/dependencies.sha256"
  [ -f "$marker" ] || return 1
  expected=$(hash_file "$lock_file")
  recorded=$(tr -d '[:space:]' < "$marker")
  [ "$recorded" = "$expected" ] || return 1
  (cd "$repo_root" && "$node_path" --input-type=module -e \
    "await Promise.all([import('ajv'),import('ajv-formats'),import('yaml')])" >/dev/null 2>&1)
}

install_locked_dependencies() {
  lock_file=$1
  node_directory=$(dirname "$node_path")
  npm_cli="$node_directory/../lib/node_modules/npm/bin/npm-cli.js"
  printf '%s\n' 'Installing verified locked dependencies for first launch...'
  if [ -f "$npm_cli" ]; then
    (cd "$repo_root" && "$node_path" "$npm_cli" ci --omit=dev --ignore-scripts --no-audit --no-fund)
  elif command -v npm >/dev/null 2>&1; then
    (cd "$repo_root" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  else
    printf '%s\n' 'npm was not found beside Node.js; install the official Node.js distribution and retry.' >&2
    return 1
  fi
  mkdir -p "$tool_root"
  hash_file "$lock_file" > "$tool_root/dependencies.sha256"
  dependencies_ready "$lock_file" || {
    printf '%s\n' 'Locked dependencies could not be verified after installation.' >&2
    return 1
  }
}

node_path=''
if node_is_usable node; then
  node_path=$(command -v node)
else
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
      node_path=$candidate
      break
    fi
  done

  if [ -z "$node_path" ]; then
    if command -v curl >/dev/null 2>&1; then
      fetch() { curl --fail --location --silent --show-error "$1" --output "$2"; }
    elif command -v wget >/dev/null 2>&1; then
      fetch() { wget -q "$1" -O "$2"; }
    else
      printf '%s\n' 'curl or wget is required to download the portable Node.js runtime.' >&2
      exit 2
    fi

    temporary=$(mktemp -d "${TMPDIR:-/tmp}/open-product-ops-node.XXXXXX")
    trap 'rm -rf "$temporary"' EXIT HUP INT TERM
    base_url='https://nodejs.org/dist/latest-v22.x'
    checksums="$temporary/SHASUMS256.txt"
    fetch "$base_url/SHASUMS256.txt" "$checksums"
    suffix="-${platform}-${architecture}.tar.gz"
    archive=$(awk -v suffix="$suffix" 'index($2,suffix)==length($2)-length(suffix)+1 {print $2; exit}' "$checksums")
    expected=$(awk -v name="$archive" '$2==name {print $1; exit}' "$checksums")
    [ -n "$archive" ] && [ -n "$expected" ] || {
      printf '%s\n' 'Portable runtime archive was not listed by nodejs.org.' >&2
      exit 2
    }
    archive_path="$temporary/$archive"
    printf '%s\n' 'Downloading verified portable Node.js runtime…'
    fetch "$base_url/$archive" "$archive_path"
    actual=$(hash_file "$archive_path")
    [ "$actual" = "$expected" ] || {
      printf '%s\n' 'Portable runtime checksum verification failed.' >&2
      exit 2
    }
    tar -xzf "$archive_path" -C "$tool_root"
    runtime_directory=${archive%.tar.gz}
    node_path="$tool_root/$runtime_directory/bin/node"
    [ -x "$node_path" ] || {
      printf '%s\n' 'Portable runtime extraction failed.' >&2
      exit 2
    }
    rm -rf "$temporary"
    trap - EXIT HUP INT TERM
  fi
fi

node_directory=$(dirname "$node_path")
PATH="$node_directory:$PATH"
export PATH
lock_file=$(find_lock_file)
if ! dependencies_ready "$lock_file"; then
  install_locked_dependencies "$lock_file"
fi
exec "$node_path" "$entrypoint" "$@"
