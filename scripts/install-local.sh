#!/usr/bin/env bash
# Package karst as a .vsix and install it into a locally installed IDE
# (VS Code, Cursor, Antigravity IDE, ...).
#
# better-sqlite3 is native and must be compiled against each IDE's own
# Electron ABI (they differ: VS Code 1.132 = ABI 146, Cursor 3.11 = ABI 143,
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
#
# macOS puts every app at a fixed /Applications bundle path, so those rows are
# literals. Windows has no such prefix — an install lands wherever the installer
# was pointed (per-user, system-wide, or another drive), so those rows are
# discovered: ask the IDE's own CLI on PATH where it lives, then fall back to
# the two standard prefixes.
add_win_target() {
  local name="$1" cmd="$2" exe="$3"
  shift 3
  local dirs=() dir on_path
  on_path="$(command -v "$cmd" 2>/dev/null || true)"
  if [ -n "$on_path" ]; then
    # <install dir>/bin/<cmd> -> <install dir>
    dirs+=("$(cd "$(dirname "$on_path")/.." && pwd)")
  fi
  dirs+=("$@")
  for dir in "${dirs[@]}"; do
    if [ -e "$dir/$exe" ]; then
      TARGETS+=("$name|$dir/$exe|$dir/bin/$cmd")
      break
    fi
  done
  return 0
}

TARGETS=()
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    add_win_target vscode code Code.exe \
      "$HOME/AppData/Local/Programs/Microsoft VS Code" "/c/Program Files/Microsoft VS Code"
    add_win_target cursor cursor Cursor.exe \
      "$HOME/AppData/Local/Programs/cursor" "/c/Program Files/cursor"
    add_win_target antigravity antigravity-ide Antigravity.exe \
      "$HOME/AppData/Local/Programs/Antigravity" "/c/Program Files/Antigravity"
    ;;
  *)
    TARGETS=(
      "vscode|/Applications/Visual Studio Code.app/Contents/MacOS/Code|/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
      "cursor|/Applications/Cursor.app/Contents/MacOS/Cursor|/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
      "antigravity|/Applications/Antigravity IDE.app/Contents/MacOS/Electron|/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"
    )
    ;;
esac

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

  if [ ! -e "$app_bin" ]; then
    echo "No $name app binary at $app_bin — cannot detect its Electron ABI." >&2
    echo "Refusing to build: ABI detection would fall back to another installed IDE and ship the wrong addon." >&2
    exit 1
  fi

  echo "== $name =="
  KARST_TARGET_APP_BINARY="$app_bin" npm run rebuild:electron

  # Verify the rebuild actually produced the correct ABI before packaging.
  expected_abi="$("$app_bin" -e 'process.stdout.write(String(process.versions.modules))' 2>/dev/null \
    || ELECTRON_RUN_AS_NODE=1 "$app_bin" -e 'process.stdout.write(String(process.versions.modules))' 2>/dev/null)"
  if [ -z "$expected_abi" ]; then
    echo "Cannot detect ABI from $app_bin — skipping verification." >&2
  else
    actual_abi="$(node -e "
      const fs = require('fs');
      try {
        const buf = fs.readFileSync('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
        const abi143 = buf.includes(Buffer.from('143'));
        const abi127 = buf.includes(Buffer.from('127'));
        process.stdout.write(abi143 ? '143' : abi127 ? '127' : 'unknown');
      } catch { process.stdout.write('missing'); }
    ")"
    if [ "$actual_abi" != "$expected_abi" ]; then
      echo "ABI MISMATCH: expected $expected_abi but got $actual_abi" >&2
      echo "The better-sqlite3 native module was not rebuilt for $name (ABI $expected_abi)." >&2
      echo "Rebuild output:" >&2
      KARST_TARGET_APP_BINARY="$app_bin" npm run rebuild:electron 2>&1 >&2
      exit 1
    fi
    echo "ABI verified: $actual_abi (matches $name)"
  fi

  # --skip-license / --allow-missing-repository stop vsce from raising the
  # packaging warnings that otherwise trigger an interactive
  # "Do you want to continue? [y/N]" confirm and stall a non-interactive run.
  # @vscode/vsce, not the legacy `vsce` package — that one is frozen at 2.15.0
  # and rejects --skip-license with "unknown option".
  KARST_TARGET_APP_BINARY="$app_bin" npx @vscode/vsce package --skip-license --allow-missing-repository
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
  VERSION=$(node -e "console.log(require('./package.json').version)")
  echo ""
  echo "Installed karst v${VERSION}"
  echo "Check version in Settings > General > Version"
  echo "Done. Reload window in each installed IDE (Cmd+Shift+P -> Reload Window)."
else
  echo "Nothing installed."
  exit 1
fi
