# Native ABI split (better-sqlite3)

Native addon; ABI must match the runtime: **Electron** for F5, **Node** for tests.
VS Code 1.126 runs **Electron 39 = ABI 140** (NOT the 42.x in its package.json — that's a build dep).
better-sqlite3 ships an ABI-140 prebuild (`bin/darwin-arm64-140/`); `rebuild:electron` copies it into `build/Release` (what `bindings` loads). `rebuild:node` recompiles for Node.

F5 auto-copies via `dev:extension`; `npm run test:unit` auto-recompiles via `pretest:unit`.
On VS Code upgrade that changes ABI: update the `darwin-arm64-<N>` folder name + `rebuild:electron` copy path.

## The addon is shared across checkouts; the installers build private copies

better-sqlite3's addon in `node_modules/better-sqlite3/build/Release` is a single
shared file that any `npm run test:unit` (main checkout or ANY worktree — a
worktree with no node_modules of its own resolves the main checkout's
better-sqlite3) flips back to the Node ABI via `pretest:unit`/`rebuild:node`.

`install-local.sh` and `package-remote.sh` no longer read or write that shared
file. Each builds its addon in a TEMP copy of the package (prebuild-install, with
an electron-rebuild fallback), verifies its ABI (for the local, same-platform
case), caches it under `.karst-cache/addons/` keyed by bsqlite version + ABI +
platform/arch, and hands it to `scripts/stage-vsix.mjs`. The helper runs one
fresh `npm run build`, copies only the shipped files into a private
`.karst-cache/stage-<name>/`, places the addon there, and lets `vsce` package the
stage — so a concurrent `npm test` can no longer flip the addon during the
~1-minute packaging window. `install-local.sh` then re-probes the addon extracted
from the finished vsix (`unzip -p …`) and refuses to install on a mismatch:
there is no retry loop and no in-place zip patch, because the packaged addon was
never the shared one to begin with. `package-remote.sh` builds a foreign
(linux-x64) addon that this machine cannot ABI-probe, so it pins the artifact by
prebuild-install's ABI-bearing cache tag and a vsix-vs-fetched shasum instead.

## rebuild-better-sqlite3.mjs delivers VERIFIED addons only

It probes the actual file after every path (vendored copy, prebuild-install download — which can exit 0 with the destination untouched — or source build), removing a stale addon before any download so a leftover wrong-ABI binary never reads as a delivery, and fast-paths when the addon already matches so `npm run test:unit`'s pretest stops churning the shared file. The fast path is backed by a `build/.abi-cache` (JSON: target ABI + runtime version + SHA-256 of the addon) written only after a fully-verified build: node mode skips the `node -e` probe spawn entirely when the addon on disk is byte-identical to the one last verified — the hash, not an mtime, so a fresh `cp -R` materialize or an external addon flip (another target's `rebuild:electron`) invalidates it and falls back to the probe, which stays the source of truth.

## Worktree isolation

When its `better-sqlite3` resolves OUTSIDE the current checkout (a worktree without its own node_modules walking up to the main checkout's), it first `cp -R`s the package into the worktree's own `node_modules/better-sqlite3`, then rebuilds THAT copy — so a worktree agent's `npm run test:unit` never flips the main checkout's addon out from under the installer, and the main checkout never materializes (its resolution is local). prebuild-install is still resolved from the original install (the copy doesn't carry it), but downloads into the copy.