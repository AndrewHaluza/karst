# Native ABI split (better-sqlite3)

Native addon; ABI must match the runtime: **Electron** for F5, **Node** for tests.
VS Code 1.126 runs **Electron 39 = ABI 140** (NOT the 42.x in its package.json — that's a build dep).
better-sqlite3 ships an ABI-140 prebuild (`bin/darwin-arm64-140/`); `rebuild:electron` copies it into `build/Release` (what `bindings` loads). `rebuild:node` recompiles for Node.

F5 auto-copies via `dev:extension`; `npm run test:unit` auto-recompiles via `pretest:unit`.
On VS Code upgrade that changes ABI: update the `darwin-arm64-<N>` folder name + `rebuild:electron` copy path.

## The addon is shared across checkouts; install-local is the final word

**`install-local.sh`'s final word is the addon INSIDE the packaged vsix, never the one in `build/Release`.** The addon is a single shared file that any `npm run test:unit` (main checkout or ANY worktree — a worktree has no node_modules of its own and resolves the main checkout's better-sqlite3) flips back to the Node ABI via `pretest:unit`/`rebuild:node`. vsce takes ~1 minute to package, so a pre-package ABI verify is a TOCTOU, not a guarantee: it passed, then the packaged vsix carried the Node binary, and the IDE failed at activation (the v1.0.0 Cursor install). install-local probes the addon extracted from the fresh vsix (`unzip -p …`) and — when a concurrent rebuild flipped it during the ~1-minute packaging window — PATCHES the vsix member in place from a private verified copy taken before packaging (one instant zip replacement, no race window), with a bounded rebuild + repackage (3 attempts) only as the fallback; either way the ARTIFACT must match before anything is installed.

## rebuild-better-sqlite3.mjs delivers VERIFIED addons only

It probes the actual file after every path (vendored copy, prebuild-install download — which can exit 0 with the destination untouched — or source build), removing a stale addon before any download so a leftover wrong-ABI binary never reads as a delivery, and fast-paths when the addon already matches so `npm run test:unit`'s pretest stops churning the shared file. The fast path is backed by a `build/.abi-cache` (JSON: target ABI + runtime version + SHA-256 of the addon) written only after a fully-verified build: node mode skips the `node -e` probe spawn entirely when the addon on disk is byte-identical to the one last verified — the hash, not an mtime, so a fresh `cp -R` materialize or an external addon flip (another target's `rebuild:electron`) invalidates it and falls back to the probe, which stays the source of truth.

## Worktree isolation

When its `better-sqlite3` resolves OUTSIDE the current checkout (a worktree without its own node_modules walking up to the main checkout's), it first `cp -R`s the package into the worktree's own `node_modules/better-sqlite3`, then rebuilds THAT copy — so a worktree agent's `npm run test:unit` never flips the main checkout's addon out from under the installer, and the main checkout never materializes (its resolution is local). prebuild-install is still resolved from the original install (the copy doesn't carry it), but downloads into the copy.