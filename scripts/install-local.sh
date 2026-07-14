#!/usr/bin/env bash
# Package karst as a .vsix and install it into a locally installed IDE
# (VS Code, Cursor, Antigravity IDE, ...).
#
# better-sqlite3 is native and must be compiled against each IDE's own
# Electron ABI (they differ: VS Code 1.126 = ABI 140, Cursor 3.11 = ABI 143,
# etc — see rebuild-better-sqlite3.mjs). A single vsix's native addon only
# works in the IDE it was rebuilt for, so we rebuild + repackage + install
# per target.
#
# With no argument the script lists the IDEs it actually found on this machine
# and asks which one to build for. Pass target name(s) to skip the prompt
# (useful in CI / scripts).
#
# Usage:
#   scripts/install-local.sh              # prompt for which detected IDE
#   scripts/install-local.sh cursor       # build+install for just cursor
#   scripts/install-local.sh cursor vscode  # multiple explicit targets
#   scripts/install-local.sh all          # every detected IDE, no prompt
set -euo pipefail
cd "$(dirname "$0")/.."

# name | app Electron binary (ABI detection) | extension-install CLI
TARGETS=(
  "vscode|/Applications/Visual Studio Code.app/Contents/MacOS/Electron|/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  "cursor|/Applications/Cursor.app/Contents/MacOS/Cursor|/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  "antigravity|/Applications/Antigravity IDE.app/Contents/MacOS/Electron|/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"
)

entry_for() {
  # echo the TARGETS row whose name == $1, or nothing
  local want="$1" entry name rest
  for entry in "${TARGETS[@]}"; do
    IFS='|' read -r name rest <<<"$entry"
    if [ "$name" = "$want" ]; then
      echo "$entry"
      return 0
    fi
  done
  return 1
}

# Names of IDEs whose app binary actually exists on this machine.
detected=()
for entry in "${TARGETS[@]}"; do
  IFS='|' read -r name app_bin _cli <<<"$entry"
  [ -e "$app_bin" ] && detected+=("$name")
done

if [ "${#detected[@]}" -eq 0 ]; then
  echo "No supported IDE found (checked: vscode, cursor, antigravity)." >&2
  exit 1
fi

# Decide which targets to build for.
selected=()
if [ "$#" -gt 0 ]; then
  # Explicit args (or the literal 'all').
  if [ "$1" = "all" ]; then
    selected=("${detected[@]}")
  else
    for arg in "$@"; do
      if entry_for "$arg" >/dev/null; then
        selected+=("$arg")
      else
        echo "Unknown target '$arg' (valid: vscode, cursor, antigravity, all)." >&2
        exit 1
      fi
    done
  fi
elif [ "${#detected[@]}" -eq 1 ]; then
  # Only one IDE present — no point prompting.
  selected=("${detected[@]}")
  echo "Only ${detected[0]} detected — building for it."
else
  # Interactive pick among detected IDEs.
  echo "Which IDE do you want to build+install karst for?"
  PS3="Select a number (or Ctrl-C to cancel): "
  select choice in "${detected[@]}" "all"; do
    if [ "$choice" = "all" ]; then
      selected=("${detected[@]}")
      break
    elif [ -n "${choice:-}" ]; then
      selected=("$choice")
      break
    else
      echo "Invalid choice, try again."
    fi
  done
fi

npm run build

installed_any=false

for name in "${selected[@]}"; do
  entry="$(entry_for "$name")"
  IFS='|' read -r _n app_bin cli_bin <<<"$entry"

  echo "== $name =="
  KARST_TARGET_APP_BINARY="$app_bin" npm run rebuild:electron
  npx vsce package
  VSIX="$(ls -t *.vsix | head -1)"

  if [ ! -e "$cli_bin" ]; then
    echo "Built $VSIX but no CLI at $cli_bin — install it manually via the $name Extensions panel."
    continue
  fi

  echo "Installing $VSIX into $name"
  "$cli_bin" --install-extension "$VSIX" --force
  installed_any=true
done

if [ "$installed_any" = true ]; then
  echo "Done. Reload window in each installed IDE (Cmd+Shift+P -> Reload Window)."
else
  echo "Nothing installed."
  exit 1
fi
