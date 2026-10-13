<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/arch/uat-host.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'arch:UATHOST-01'):
  awk "/^## \[@arch:UATHOST-01\]/,/END_DOC_BLOCK: \[@arch:UATHOST-01\]/" docs/arch/uat-host.md
-->
# UAT host harness (`scripts/uat-host/`, `docker/uat-host/`, `src/uatHost/`)

Related: `docs/arch/ABI.md` (`arch:ABI-01`, `ABI-03`).

## [@arch:UATHOST-01] UAT host harness boots the real extension host in Docker with a fake core

`npm run uat:host:docker -- --fixture <empty|ticket-mid-stage|blocked>` builds `karst-uat-host:local`, runs it `--rm --init`, and inside it: `npm ci` and build into a container-private `node_modules` volume (ABI-01/ABI-03), downloads the pinned VS Code (`UAT_VSCODE_VERSION`, default 1.126.0, cached in the `karst-uat-vscode` volume), rebuilds better-sqlite3 for that binary's Electron ABI, seeds `karst.db` and a scratch git workspace by running `dist/uat-host/prepare.js` under the VS Code binary (`ELECTRON_RUN_AS_NODE=1`, so the addon ABI matches), then launches VS Code under xvfb with a temp user-data dir, a temp extensions dir and `scripts/uat-host/settings.json`. `KARST_FAKE_CORE=1` makes `resolveAdapter` return `FakeAdapter` for every provider: no LLM call. `activate()` returns normally when the store open fails, so the in-host runner also requires a registered `karst.*` command and the seeded ticket count. Never point the harness at a real Cursor/Code profile.

- **ABI is derived, never hardcoded.** The container entrypoint runs `run.mjs --print-vscode` (downloads and prints the VS Code binary path), exports it as `KARST_TARGET_APP_BINARY`, then runs `rebuild:electron`, which reads the ABI from that binary. VS Code 1.126.0 ships Electron 42.2.0 (ABI 146), not the Electron 39 / ABI 140 of the F5 host; a hardcoded number would be wrong after any version bump.
- **No concurrent runs against one checkout.** All runs share the `karst-uat-vscode` volume and bind-mount the checkout (so `dist/`). Run one at a time.
- **Architecture.** The container runs the host's arch: arm64 on Apple silicon. x64 (CI) is untested.
- **Teardown.** `docker.mjs` force-removes the named container on exit and on SIGINT/SIGTERM/SIGHUP.

END_DOC_BLOCK: [@arch:UATHOST-01]
