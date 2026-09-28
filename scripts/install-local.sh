#!/bin/sh
# Installs the T3 Code CLI from the local repository build into the user's
# system, mirroring the exact layout and behavior of the native release installer:
#   $T3CODE_HOME/runtime/versions/<version>   (default: ~/.t3/runtime/versions/<version>)
#   $T3CODE_INSTALL_BIN_DIR/t3                (default: ~/.local/bin/t3)
#
# Usage:
#   ./scripts/install-local.sh [--skip-build]
#
# Environment:
#   T3CODE_HOME              T3 home directory (default: ~/.t3)
#   T3CODE_INSTALL_BIN_DIR   where the `t3` symlink goes (default: ~/.local/bin)
#   T3CODE_NODE              specific node binary to run t3 (default: node from PATH)
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
skip_build=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=true ;;
    -h|--help)
      printf 'Usage: %s [--skip-build]\n\nInstalls T3 Code locally into %s/runtime/versions/<version> and %s/t3\n' "$0" "$t3_home" "$bin_dir"
      exit 0
      ;;
  esac
done

fail() {
  printf '\nt3 install: %s\n' "$1" >&2
  exit 1
}

# ANSI colors for terminal output
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi

step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}

if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       T3 Code' >&2
  printf '  %s%s     %sCLI installer (local)%s\n' '    ███       ████▄ ' "$reset" "$muted" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi

command -v node >/dev/null 2>&1 || fail "Node.js (v24+) is required"
node_bin="${T3CODE_NODE:-$(command -v node)}"

# Extract version from apps/server/package.json
version="$(node -e 'try { console.log(JSON.parse(fs.readFileSync("apps/server/package.json")).version); } catch { console.log("0.0.42"); }' 2>/dev/null || echo "0.0.42")"

if [ "$skip_build" = false ]; then
  step "Building web client assets..."
  if command -v vp >/dev/null 2>&1; then
    (cd "$repo_root" && vp run --filter @t3tools/web build >/dev/null)
  elif command -v pnpm >/dev/null 2>&1; then
    (cd "$repo_root" && pnpm --filter @t3tools/web build >/dev/null)
  else
    (cd "$repo_root/apps/web" && npm run build >/dev/null)
  fi

  step "Building server bundle..."
  if command -v vp >/dev/null 2>&1; then
    (cd "$repo_root" && vp run --filter t3 build:bundle >/dev/null)
  elif command -v pnpm >/dev/null 2>&1; then
    (cd "$repo_root" && pnpm --filter t3 build:bundle >/dev/null)
  else
    (cd "$repo_root/apps/server" && npm run build:bundle >/dev/null)
  fi
fi

# Verify build outputs exist
[ -f "$repo_root/apps/server/dist/bin.mjs" ] || fail "server bundle missing at apps/server/dist/bin.mjs; run build first"
[ -f "$repo_root/apps/web/dist/index.html" ] || fail "web bundle missing at apps/web/dist/index.html; run build first"

versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

step "Staging runtime at ${target_dir}..."
mkdir -p "$versions_dir"
staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
trap 'rm -rf "$staging"' EXIT INT TERM

# Copy server bundle, workers, and client static assets
cp -R "$repo_root/apps/server/dist/"* "$staging/"
mkdir -p "$staging/client"
cp -R "$repo_root/apps/web/dist/"* "$staging/client/"

# Symlink native/external node_modules so addons resolve seamlessly
if [ -d "$repo_root/apps/server/node_modules" ]; then
  ln -sfn "$repo_root/apps/server/node_modules" "$staging/node_modules"
elif [ -d "$repo_root/node_modules" ]; then
  ln -sfn "$repo_root/node_modules" "$staging/node_modules"
fi

# Create launcher executable
cat << 'LAUNCHER' > "$staging/t3"
#!/usr/bin/env sh
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$DIR/$SOURCE" ;;
  esac
done
DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"
NODE_BIN="${T3CODE_NODE:-$(command -v node 2>/dev/null || echo "node")}"
export NODE_PATH="${DIR}/node_modules:${DIR}/../../node_modules:${NODE_PATH:-}"
exec "$NODE_BIN" "${DIR}/bin.mjs" "$@"
LAUNCHER
chmod +x "$staging/t3"

# Verify test run inside staging
"$staging/t3" --version >/dev/null 2>&1 || fail "the staged t3 executable failed to run"
printf '%s\n' "$version" > "$staging/.install-complete"

# Move staging into final target version directory
rm -rf "$target_dir"
mv "$staging" "$target_dir"
trap - EXIT INT TERM

step "Setting up the t3 command in ${bin_dir}..."
mkdir -p "$bin_dir"
ln -sfn "${target_dir}/t3" "${bin_dir}/t3"

if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled T3 Code %s%s (with Command Code support)\n\n' "$green" "$version" "$reset" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %st3%s to get started.\n\n' "$bold" "$reset" ;;
  *) printf '  Add %s to your PATH, then run %st3%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
esac
