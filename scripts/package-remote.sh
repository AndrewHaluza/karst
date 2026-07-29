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
# Usage: scripts/package-remote.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION=24.0.0   # any 24.x maps to ABI 137; only the ABI is load-bearing
ABI=137
PLATFORM=linux
ARCH=x64
OUT="karst-$(node -p "require('./package.json').version")-$PLATFORM-$ARCH.vsix"

echo "Target: node $NODE_VERSION (ABI $ABI) $PLATFORM-$ARCH -> $OUT"

# Restore the local tree on ANY exit: this rewrites package.json (prepublish
# hook, below) and better-sqlite3's addon (now a foreign-platform binary).
# Leaving either behind breaks F5 and `npm test` in ways that look unrelated.
MODULE_DIR="$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")"
PKG_BACKUP="$(mktemp)"
cp package.json "$PKG_BACKUP"
restore() {
  cp "$PKG_BACKUP" package.json
  rm -f "$PKG_BACKUP"
  echo "Restoring the local Electron addon (this tree is for F5, not the vsix)..."
  npm run rebuild:electron >/dev/null 2>&1 || echo "  rebuild:electron failed — run it yourself before F5." >&2
}
trap restore EXIT

npm run build

PREBUILD_BIN="$(node -p "require('module').createRequire(require.resolve('better-sqlite3/package.json')).resolve('prebuild-install/bin.js')")"
(cd "$MODULE_DIR" && node "$PREBUILD_BIN" \
  --runtime node --target "$NODE_VERSION" --platform "$PLATFORM" --arch "$ARCH")

# prebuild-install exits 0 whether it downloaded or reused cache, and `file` only
# proves platform, never ABI. The cache filename carries both — assert on it.
CACHE_TAG="node-v$ABI-$PLATFORM-$ARCH"
if ! ls "$HOME"/.npm/_prebuilds/ 2>/dev/null | grep -q -- "$CACHE_TAG"; then
  echo "No prebuild matching $CACHE_TAG in ~/.npm/_prebuilds — refusing to package." >&2
  exit 1
fi
echo "Addon: $(basename "$(ls -t "$HOME"/.npm/_prebuilds/*"$CACHE_TAG"* | head -1)")"

# vsce always runs `vscode:prepublish`, and karst's runs rebuild:electron, which
# would overwrite the addon just fetched with a local-Electron one. No
# --no-prepublish flag exists, so drop the hook; the EXIT trap puts it back.
npm pkg delete scripts.vscode:prepublish
npx @vscode/vsce package \
  --skip-license --allow-missing-repository \
  --target "$PLATFORM-$ARCH" -o "$OUT"

# Prove the addon INSIDE the vsix is the one fetched — vsce ignore rules and a
# stray rebuild have both silently swapped it before.
packed="$(unzip -p "$OUT" 'extension/node_modules/better-sqlite3/build/Release/better_sqlite3.node' | shasum | cut -d' ' -f1)"
tree="$(shasum "$MODULE_DIR/build/Release/better_sqlite3.node" | cut -d' ' -f1)"
if [ "$packed" != "$tree" ]; then
  echo "Addon in $OUT does not match the fetched one ($packed != $tree)." >&2
  exit 1
fi

cat <<EOF

Packaged $OUT for node $NODE_VERSION / ABI $ABI / $PLATFORM-$ARCH.

Install on the VM:
  scp $OUT VM@VM-vm:~/
  code --install-extension ~/$OUT --force
Then Reload Window.
EOF
