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
#   scripts/install-local.sh --no-cache   # bypass build/rebuild/vsix caches
#   scripts/install-local.sh --clean      # delete all caches then exit
set -euo pipefail
cd "$(dirname "$0")/.."

# --- Cache management ---------------------------------------------------
# Skip expensive steps (TS build, native addon rebuild, vsix packaging)
# when source hasn't changed.  Pass --no-cache to bypass all checks.
# Pass --clean to delete all caches then exit.
CACHE_DIR=".karst-cache"
for arg in "$@"; do
  if [ "$arg" = "--clean" ]; then
    echo "Cleaning install-local caches..."
    rm -rf "$CACHE_DIR"
    echo "Done."
    exit 0
  fi
done

USE_CACHE=true
for arg in "$@"; do
  [ "$arg" = "--no-cache" ] && USE_CACHE=false
done

mkdir -p "$CACHE_DIR"

# --- ABI probe -----------------------------------------------------------
# Echo a .node addon's NODE_MODULE_VERSION, or "unknown" (or empty on a
# probe failure).  The probe runs under the LOCAL node: an ABI mismatch
# aborts BEFORE dlopen and names the addon's version on stderr — "compiled
# against a different Node.js version using NODE_MODULE_VERSION <n>" — so
# macOS code signing (which blocks dlopen of differently-signed addons in
# Electron) never interferes with the verdict; a match loads cleanly and its
# ABI is this node's own.  This works for EVERY ABI, unlike the byte-scan it
# replaces, which only knew 143 and 127.
addon_abi() {
  local addon="$1" out rc
  out="$(node -e "require(process.argv[1])" "$addon" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    node -p "process.versions.modules"
  else
    printf '%s' "$out" | grep -oE "NODE_MODULE_VERSION [0-9]+" | head -1 | awk '{print $2}'
  fi
}

# --- IDE targets ---------------------------------------------------------
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

# Decide which targets to build for.  Flags are filtered out first so a
# flag-only invocation (e.g. `install-local.sh --no-cache`) falls through
# to the same prompt/auto-select behavior as a no-arg run.
selected=()
targets=()
for arg in "$@"; do
  [ "$arg" = "--no-cache" ] && continue
  targets+=("$arg")
done

if [ "${#targets[@]}" -gt 0 ]; then
  # Explicit args (or the literal 'all').
  has_all=false
  for arg in "${targets[@]}"; do
    if [ "$arg" = "all" ]; then has_all=true; fi
  done
  if [ "$has_all" = true ]; then
    selected=("${detected[@]}")
  else
    for arg in "${targets[@]}"; do
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

# --- TS build (cached) ---------------------------------------------------
BUILD_STAMP="$CACHE_DIR/build.stamp"
build_needed=true
if [ "$USE_CACHE" = true ] && [ -f "$BUILD_STAMP" ]; then
  # Rebuild if any source or config file is newer than the stamp
  stale=$(find src/ package.json tsconfig.json tsconfig.build.json -newer "$BUILD_STAMP" \
    -print -quit 2>/dev/null || true)
  if [ -z "$stale" ]; then
    build_needed=false
    echo "Build cache hit — skipping TS compile"
  fi
fi
if [ "$build_needed" = true ]; then
  npm run build
  touch "$BUILD_STAMP"
fi

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

  # --- Native addon rebuild (cached, per-target) ----------------------
  # The addon at build/Release is a SINGLE shared file that several paths
  # replace out-of-band: another target's rebuild:electron, `npm test`'s
  # pretest (rebuild:node), an IDE auto-update, a fresh npm ci.  A cache
  # keyed on mtimes cannot see any of those — and the addon's mtime is the
  # release archive's, not the install's (prebuild-install extracts from a
  # cached tarball, and tar preserves the archive's mtime), so mtime is not
  # even a real change signal.  The cache verdict is therefore the addon's
  # ACTUAL ABI (probed via addon_abi) against the IDE's CURRENT Electron
  # ABI: if they match, the addon is by definition what this IDE needs,
  # whatever wrote it.
  VSIX_STAMP="$CACHE_DIR/vsix-${name}.stamp"

  # Ask the IDE's embedded Electron binary for its ABI.  MUST run with
  # ELECTRON_RUN_AS_NODE=1: without it the binary starts the real app (GUI,
  # single-instance hand-off) and blocks forever when the IDE is not running —
  # the bare `-e` probe hung the script.  This is the same probe
  # rebuild-better-sqlite3.mjs's detectElectronRuntime uses.
  expected_abi="$(ELECTRON_RUN_AS_NODE=1 "$app_bin" -e 'process.stdout.write(String(process.versions.modules))' 2>/dev/null || true)"

  addon="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  addon_abs="$PWD/$addon"
  rebuild_needed=true
  if [ "$USE_CACHE" = true ] && [ -f "$addon" ] && [ -n "$expected_abi" ]; then
    if [ "$(addon_abi "$addon_abs")" = "$expected_abi" ]; then
      rebuild_needed=false
      echo "Rebuild cache hit — addon ABI $expected_abi matches $name"
    fi
  fi
  if [ "$rebuild_needed" = true ]; then
    KARST_TARGET_APP_BINARY="$app_bin" npm run rebuild:electron

    # Verify the rebuilt addon actually targets this IDE's ABI before
    # packaging.
    if [ -z "$expected_abi" ]; then
      echo "Cannot detect ABI from $app_bin — skipping verification." >&2
    elif [ "$(addon_abi "$addon_abs")" = "$expected_abi" ]; then
      echo "ABI verified: $expected_abi (matches $name)"
    else
      echo "ABI MISMATCH: expected $expected_abi but got $(addon_abi "$addon_abs")" >&2
      echo "The better-sqlite3 native module was not rebuilt for $name (ABI $expected_abi)." >&2
      echo "Rebuild output:" >&2
      KARST_TARGET_APP_BINARY="$app_bin" npm run rebuild:electron 2>&1 >&2
      exit 1
    fi
    # The addon inside the existing vsix is now stale — force a repackage.
    rm -f "$VSIX_STAMP"
  fi

  # --- Vsix packaging (cached, per-target) -----------------------------
  # The vsix is named per-target (vsce's default name is version-only, so
  # two targets would overwrite each other's artifact) and the stamp records
  # its filename, so a cache hit can only reuse the file THIS target built.
  vsix_needed=true
  if [ "$USE_CACHE" = true ] && [ -f "$VSIX_STAMP" ]; then
    VSIX="$(cat "$VSIX_STAMP" 2>/dev/null || true)"
    if [ -n "$VSIX" ] && [ -f "$VSIX" ]; then
      # Repackage if src/, package.json, dist/ or the packaging config
      # changed since last packaging.
      stale=$(find src/ package.json dist/ .vscodeignore -newer "$VSIX_STAMP" -print -quit 2>/dev/null || true)
      if [ -z "$stale" ]; then
        vsix_needed=false
        echo "Vsix cache hit — reusing $VSIX"
      fi
    fi
  fi
  if [ "$vsix_needed" = true ]; then
    # --skip-license / --allow-missing-repository stop vsce from raising the
    # packaging warnings that otherwise trigger an interactive
    # "Do you want to continue? [y/N]" confirm and stall a non-interactive run.
    # @vscode/vsce, not the legacy `vsce` package — that one is frozen at 2.15.0
    # and rejects --skip-license with "unknown option".
    ver="$(node -e "console.log(require('./package.json').version)")"
    VSIX="$CACHE_DIR/karst-${ver}-${name}.vsix"
    KARST_TARGET_APP_BINARY="$app_bin" npx @vscode/vsce package \
      --skip-license --allow-missing-repository --out "$VSIX"
    printf '%s\n' "$VSIX" > "$VSIX_STAMP"
  fi

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
