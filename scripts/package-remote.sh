#!/usr/bin/env bash
# Package karst as a .vsix for the REMOTE extension host (Remote-SSH VM).
#
# A remote extension host runs the VS Code Server's own PLAIN NODE — not
# Electron — on the server's platform/arch, so the better-sqlite3 addon in the
# vsix must be built for that tuple, none of which match this machine. Values
# below come from the live server (`<server>/node -p process.versions.modules`);
# re-read them if the VM's VS Code Server updates, because a mismatch fails at
# activation with:
#   Error: ... compiled against a different Node.js version using
#   NODE_MODULE_VERSION 127. This version of Node.js requires 137.
#
# Every run does a fresh `npm run build` and packages from a throwaway stage via
# scripts/stage-vsix.mjs, so this script never edits the repo's package.json and
# never rebuilds the shared node_modules/better-sqlite3 addon. It is safe to run
# concurrently with install-local.sh.
#
# Usage: scripts/package-remote.sh
#
# Copy to the VM (optional, prompted) needs two env vars — kept out of the repo:
#   KARST_REMOTE_HOST      ssh host, e.g. user@host or an ssh_config alias
#   KARST_REMOTE_BUILD_DIR absolute directory on that host
# Set them in the environment, or in a gitignored .env.local at the repo root
# (sourced below), so the VM's identity never reaches a commit.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

NODE_VERSION=24.0.0   # any 24.x maps to ABI 137; only the ABI is load-bearing
ABI=137
PLATFORM=linux
ARCH=x64
VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short=8 HEAD 2>/dev/null || echo nogit)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  COMMIT="$COMMIT-dirty"
fi

# Build index: monotonic sequence so a pile of vsix files reads in build order.
# Derived from the files already here (builds 1-14 predate the commit hash in the
# name) rather than a counter file, so nothing extra has to be kept in sync.
FIRST_INDEX=15
INDEX="$FIRST_INDEX"
for f in karst-*-"$PLATFORM"-"$ARCH"-*.vsix; do
  [ -e "$f" ] || continue
  n="${f#karst-*-$PLATFORM-$ARCH-}"
  n="${n%%-*}"
  n="${n%.vsix}"
  case "$n" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$n" -ge "$INDEX" ]; then
    INDEX=$((n + 1))
  fi
done

OUT="karst-$VERSION-$PLATFORM-$ARCH-$INDEX-$COMMIT.vsix"

echo "Target: node $NODE_VERSION (ABI $ABI) $PLATFORM-$ARCH -> $OUT"
echo "Build:  #$INDEX at commit $COMMIT"

# --- Foreign-platform addon ---------------------------------------------
# Fetch better-sqlite3's published linux-x64 prebuild into a TEMP copy of the
# package (never the shared node_modules addon). It cannot be ABI-probed under
# this machine's node — the runtime is a foreign platform — so the artifact is
# pinned twice instead: prebuild-install's cache filename carries the ABI, and
# the vsix member is shasum-compared to the fetched file after packaging.
BSQLITE_DIR="$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")"
PREBUILD_BIN="$(node -p "require('module').createRequire(require.resolve('better-sqlite3/package.json')).resolve('prebuild-install/bin.js')")"

CACHE_DIR=".karst-cache"
# Per-process stage name: two package-remote.sh runs must not share
# `.karst-cache/stage-remote`, or one run's wipe deletes the directory the other
# is still packaging from.
STAGE_NAME="remote-$$"
ADDON_TMP="$(mktemp -d)"
cleanup() { rm -rf "$ADDON_TMP" "$CACHE_DIR/stage-$STAGE_NAME"; }
trap cleanup EXIT

mkdir -p "$ADDON_TMP/node_modules"
cp -R "$BSQLITE_DIR" "$ADDON_TMP/node_modules/better-sqlite3"
printf '{"name":"karst-addon-build","version":"0.0.0","private":true}\n' > "$ADDON_TMP/package.json"
ADDON="$ADDON_TMP/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

echo "Fetching better-sqlite3 prebuild for node $NODE_VERSION $PLATFORM-$ARCH..."
(
  cd "$ADDON_TMP/node_modules/better-sqlite3" &&
    node "$PREBUILD_BIN" \
      --runtime node --target "$NODE_VERSION" --platform "$PLATFORM" --arch "$ARCH"
)

# prebuild-install exits 0 whether it downloaded or reused cache, and `file` only
# proves platform, never ABI. The cache filename carries both — assert on it.
CACHE_TAG="node-v$ABI-$PLATFORM-$ARCH"
if ! ls "$HOME"/.npm/_prebuilds/ 2>/dev/null | grep -q -- "$CACHE_TAG"; then
  echo "No prebuild matching $CACHE_TAG in ~/.npm/_prebuilds — refusing to package." >&2
  exit 1
fi
echo "Addon: $(basename "$(ls -t "$HOME"/.npm/_prebuilds/*"$CACHE_TAG"* | head -1)")"

# --- One fresh build + stage + package -----------------------------------
# The helper runs a full `npm run build`, stages only the shipped files, drops
# scripts.vscode:prepublish in the stage, writes dist/build-info.json, places
# the addon above and packages with --target linux-x64. Nothing here mutates the
# repo's package.json or its shared addon.
node scripts/stage-vsix.mjs --name "$STAGE_NAME" \
  --addon "$ADDON" --target "$PLATFORM-$ARCH" --out "$OUT"

# Prove the addon INSIDE the vsix is the one fetched — vsce ignore rules and a
# stray rebuild have both silently swapped it before.
packed="$(unzip -p "$OUT" 'extension/node_modules/better-sqlite3/build/Release/better_sqlite3.node' | shasum | cut -d' ' -f1)"
tree="$(shasum "$ADDON" | cut -d' ' -f1)"
if [ "$packed" != "$tree" ]; then
  echo "Addon in $OUT does not match the fetched one ($packed != $tree)." >&2
  exit 1
fi

echo
echo "Packaged $OUT for node $NODE_VERSION / ABI $ABI / $PLATFORM-$ARCH (build #$INDEX, $COMMIT)."

# Copying is optional — a build is often just a local artifact. Ask, and skip
# silently when the env is not configured or there is no terminal to ask on.
copy_to_vm() {
  if [ -z "${KARST_REMOTE_HOST:-}" ] || [ -z "${KARST_REMOTE_BUILD_DIR:-}" ]; then
    echo "Set KARST_REMOTE_HOST and KARST_REMOTE_BUILD_DIR to enable copying to the VM."
    return 0
  fi
  if [ ! -t 0 ]; then
    echo "Not a terminal — skipping the copy to $KARST_REMOTE_HOST."
    return 0
  fi
  printf 'Copy %s to %s:%s? [y/N] ' "$OUT" "$KARST_REMOTE_HOST" "$KARST_REMOTE_BUILD_DIR"
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Skipped the copy."; return 0 ;;
  esac
  ssh "$KARST_REMOTE_HOST" "mkdir -p '$KARST_REMOTE_BUILD_DIR'"
  scp "$OUT" "$KARST_REMOTE_HOST:$KARST_REMOTE_BUILD_DIR/"
  echo "Copied to $KARST_REMOTE_HOST:$KARST_REMOTE_BUILD_DIR/$OUT"
  echo
  echo "Install on the VM:"
  echo "  code --install-extension '$KARST_REMOTE_BUILD_DIR/$OUT' --force"
  echo "Then Reload Window."
}
copy_to_vm
