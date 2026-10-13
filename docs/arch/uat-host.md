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
- **Running the boot test.** It is opt-in (needs docker and `UAT_HOST_DOCKER=1`; the default `integration` job skips it): `UAT_HOST_DOCKER=1 npx vitest run --config vitest.integration.config.ts src/uatHost/boot.integration.test.ts`.
- **Fake core is honored in production builds.** `KARST_FAKE_CORE=1` is read by `resolveAdapter` in every build, not only the harness; it logs one `console.warn` per process when active.
- **File ownership.** The container runs as root; the entrypoint chowns the bind-mounted checkout back to `HOST_UID:HOST_GID` (passed by `docker.mjs`) on exit, skipping `node_modules` and skipping when the uid is 0.
- **Teardown.** `docker.mjs` force-removes the named container on exit and on SIGINT/SIGTERM/SIGHUP.

END_DOC_BLOCK: [@arch:UATHOST-01]

## [@arch:UATHOST-02] The probe runs a JSON step script in the host and dumps evidence per step

`npm run uat:host:docker -- --fixture <name> --script <steps.json> --out <dir>` adds the probe to a harness run. Only a given `--script` sets `KARST_UAT_PROBE=1`; without that flag `installProbeRecorder` returns undefined, nothing patches `vscode.window`, and `karst.uatProbe.run` is never registered (it is not in `package.json` either). Pins: `src/uatHost/probe/gating.test.ts`.

- **Steps are data.** `steps.ts` validates `command` (VS Code command + args), `wait` (exactly one of `ticketStage`, `notification`, `log`, `webviewMessage`) and `snapshot`; unknown types are refused. Timeouts default to 10s and clamp to 60s.
- **Evidence.** After each step `<out>/step-NNN.json` holds `{step, result, snapshot}`; `<out>/summary.json` lists per-step `pass|fail|timeout` with the step index. The snapshot is tickets and stages from the store (no ids or timestamps), the sidebar's last posted message, open webview panels with their last posted message, notifications shown, and a 40-line log tail with timestamps and the workspace hash stripped. Same fixture and script give byte-identical JSON. The sidebar webview only appears once VS Code resolves it (it is not resolved while hidden). Writes are async (`fs/promises`) and a wait that is not about tickets does not read the store, so the probe does not block the host's event loop.
- **Never hangs.** Per-step timeout, a 120s script total, and a `UAT_PROBE_HARD_TIMEOUT_MS` (default 300s) backstop in `run.mjs`. The backstop runs the tests in a detached child (its own process group) and SIGKILLs the group, so a wedged VS Code host is reaped instead of left running. The run stops at the first non-pass step and exits nonzero, printing `uat-probe: step <i> (<type>) PASS|FAIL|TIMEOUT` and the evidence path. `--out` is relative to the checkout when run through Docker. A sample is `scripts/uat-host/samples/smoke.json`.

END_DOC_BLOCK: [@arch:UATHOST-02]
