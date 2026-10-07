#!/usr/bin/env bash
# Package karst as a .vsix and install it into a locally installed IDE
# (VS Code, Cursor, Antigravity IDE, ...).
#
# better-sqlite3 is native and must match each IDE's own Electron ABI (they
# differ: VS Code 1.132 = ABI 146, Cursor 3.11 = ABI 143, ...). This script
# builds ONE fresh VSIX per detected IDE, each carrying an addon compiled for
# that IDE, via the shared scripts/stage-vsix.mjs helper.
#
# Every run does a fresh `npm run build` (no TS or vsix cache, no mtime stamps).
# The only cache is a third-party prebuilt better-sqlite3 addon keyed by
# bsqlite version + Electron ABI + platform/arch, and it is ABI-verified on
# every use. Neither this script nor the helper ever edits the repo's
# package.json or the shared node_modules/better-sqlite3 addon — addons are
# built in temp copies.
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
#   scripts/install-local.sh --no-cache   # accepted no-op (nothing is cached but the addon)
#   scripts/install-local.sh --clean      # delete .karst-cache then exit
set -euo pipefail
cd "$(dirname "$0")/.."

# --- Cache management ---------------------------------------------------
# `--clean` wipes every artifact this tool chain produced (build lock, stages,
# per-IDE vsix, cached addons). `--no-cache` is accepted for backwards
# compatibility and is a no-op: builds are never cached, so there is nothing to
# bypass. The addon cache is keyed and ABI-verified, not a build cache.
CACHE_DIR=".karst-cache"
for arg in "$@"; do
  if [ "$arg" = "--clean" ]; then
    echo "Cleaning install-local caches..."
    rm -rf "$CACHE_DIR"
    echo "Done."
    exit 0
  fi
done

mkdir -p "$CACHE_DIR"
ADDON_CACHE="$CACHE_DIR/addons"
# Per-process stage name: two install-local.sh runs on one machine must not
# share `.karst-cache/stage-local`, or the second run's wipe deletes the
# directory the first is still packaging from (its vsce cwd vanishes mid-scan).
STAGE_NAME="local-$$"

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
  # require() treats a path without ./ or / as a bare package specifier and
  # walks node_modules — the caller's relative cache paths (.karst-cache/...)
  # would read as a package name, "Cannot find module", and report no ABI.
  case "$addon" in
    /*|./*) ;;
    *) addon="./$addon" ;;
  esac
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

# --- Per-IDE addon -------------------------------------------------------
# The addon cache lives OUTSIDE the repo's node_modules on purpose: the shared
# addon is flipped by every `npm test` (pretest runs rebuild:node against the
# main checkout), so reading it here would be a race. Key by everything that
# changes the binary; verify the cached file's ABI on every use and regenerate
# on a mismatch.
BSQLITE_DIR="$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")"
BSQLITE_VER="$(node -p "require('better-sqlite3/package.json').version")"
NODE_PLATFORM="$(node -p process.platform)"
NODE_ARCH="$(node -p process.arch)"

TMP_ADDON=""
# Must end on a success status: an EXIT trap's last command becomes the script's
# exit status when the body completed normally, and `[ -n "$TMP_ADDON" ]` is
# false (status 1) on the common path where no temp build dir was created.
cleanup() {
  if [ -n "$TMP_ADDON" ]; then rm -rf "$TMP_ADDON"; fi
  rm -rf "$CACHE_DIR/stage-$STAGE_NAME"
  return 0
}
trap cleanup EXIT

# Echo the path to a verified better-sqlite3 addon for Electron ABI $1,
# version $2, regenerating the cache entry when it is missing or wrong.
ensure_addon() {
  local abi="$1" electron_ver="$2"
  local out="$ADDON_CACHE/better_sqlite3-${BSQLITE_VER}-electron-${abi}-${NODE_PLATFORM}-${NODE_ARCH}.node"
  if [ -f "$out" ] && [ "$(addon_abi "$out")" = "$abi" ]; then
    echo "$out"
    return 0
  fi
  [ -f "$out" ] && echo "Cached addon ABI does not match $abi — regenerating." >&2
  rm -f "$out"

  echo "Building better-sqlite3 for Electron $electron_ver (ABI $abi)..." >&2
  local tmp
  tmp="$(mktemp -d)"
  TMP_ADDON="$tmp"
  mkdir -p "$tmp/node_modules"
  cp -R "$BSQLITE_DIR" "$tmp/node_modules/better-sqlite3"
  printf '{"name":"karst-addon-build","version":"0.0.0","private":true}\n' > "$tmp/package.json"

  local prebuild_bin built
  prebuild_bin="$(node -p "require('module').createRequire(require.resolve('better-sqlite3/package.json')).resolve('prebuild-install/bin.js')")"
  built="$tmp/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

  if ! (
    cd "$tmp/node_modules/better-sqlite3" &&
      node "$prebuild_bin" --runtime electron --target "$electron_ver" \
        --platform "$NODE_PLATFORM" --arch "$NODE_ARCH"
  ) || [ "$(addon_abi "$built")" != "$abi" ]; then
    echo "prebuild-install did not deliver ABI $abi — falling back to a source build." >&2
    npm exec -- electron-rebuild -f -w better-sqlite3 \
      --version "$electron_ver" --arch "$NODE_ARCH" --module-dir "$tmp" >&2
  fi

  if [ "$(addon_abi "$built")" != "$abi" ]; then
    echo "Failed to build a better-sqlite3 addon for ABI $abi (got $(addon_abi "$built"))." >&2
    exit 1
  fi
  echo "Built a verified ABI $abi addon." >&2

  mkdir -p "$ADDON_CACHE"
  cp "$built" "$out"
  rm -rf "$tmp"
  TMP_ADDON=""
  echo "$out"
}

# --- One fresh build + stage for the whole run ---------------------------
# Regardless of how many IDEs were selected: one `npm run build`, one stage,
# then a vsix per IDE from that stage.
node scripts/stage-vsix.mjs --stage-only --name "$STAGE_NAME"

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

  # Ask the IDE's embedded Electron binary for its ABI AND Electron version.
  # MUST run with ELECTRON_RUN_AS_NODE=1: without it the binary starts the real
  # app (GUI, single-instance hand-off) and blocks forever when the IDE is not
  # running. This is the same probe rebuild-better-sqlite3.mjs uses.
  probe="$(ELECTRON_RUN_AS_NODE=1 "$app_bin" -e 'process.stdout.write(process.versions.modules + " " + process.versions.electron)' 2>/dev/null || true)"
  expected_abi="${probe%% *}"
  electron_ver="${probe##* }"
  if [ -z "$expected_abi" ] || [ "$expected_abi" = "$probe" ]; then
    echo "Cannot detect an Electron ABI from $app_bin — refusing to package an unverifiable addon." >&2
    exit 1
  fi
  echo "Detected Electron $electron_ver (ABI $expected_abi) for $name"

  addon="$(ensure_addon "$expected_abi" "$electron_ver")"

  # Package from the stage (never the repo's shared addon), so a concurrent
  # `npm test` cannot flip the addon while vsce runs.
  ver="$(node -p "require('./package.json').version")"
  VSIX="$CACHE_DIR/karst-${ver}-${name}.vsix"
  node scripts/stage-vsix.mjs --reuse-stage --name "$STAGE_NAME" \
    --addon "$addon" --out "$VSIX"

  # Verify the addon INSIDE the freshly packaged vsix — that is the file the
  # IDE will load. The stage addon is private, so a mismatch here is a real
  # failure, not a lost race: fail loudly rather than install a broken build.
  vsix_addon_path="extension/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  # The probe file MUST end in `.node`: node's require() only uses the native
  # addon loader for that extension, and a bare mktemp file would be read as JS.
  verify_node="$CACHE_DIR/vsix-${name}-verify.node"
  rm -f "$verify_node"
  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$VSIX" "$vsix_addon_path" > "$verify_node" 2>/dev/null || true
  else
    tar -xOf "$VSIX" "$vsix_addon_path" > "$verify_node" 2>/dev/null || true
  fi
  got_abi="$(addon_abi "$verify_node" || true)"
  rm -f "$verify_node"
  if [ "$got_abi" != "$expected_abi" ]; then
    echo "Addon inside $VSIX is ABI ${got_abi:-none}, expected $expected_abi." >&2
    exit 1
  fi
  echo "Packaged addon verified: ABI $got_abi inside $VSIX"

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
