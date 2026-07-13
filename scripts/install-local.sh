#!/usr/bin/env bash
# Package karst as a .vsix and install into local VS Code (real install, not F5).
# Native better-sqlite3 must match Electron ABI (140) — rebuild:electron sets that.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npm run rebuild:electron
npx vsce package
VSIX="$(ls -t *.vsix | head -1)"
echo "Installing $VSIX"
code --install-extension "$VSIX" --force

echo "Done. Reload VS Code window (Cmd+Shift+P -> Reload Window)."
