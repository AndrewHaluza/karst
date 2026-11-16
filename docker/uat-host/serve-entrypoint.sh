#!/bin/bash
# Serve-mode entrypoint (arch:UATHOST-08): build a container-private copy of /work, then run the supervisor.
# The copy keeps a host build (`npm run clean` deletes dist/) or a one-shot run in the same worktree away from the live host.
set -euo pipefail
mkdir -p /srv/karst
tar -C /work --exclude=./node_modules --exclude=./.git --exclude=./.karst --exclude=./dist \
    --exclude=./.stryker-tmp --exclude=./.vscode-test --exclude=./test-results -cf - . | tar -C /srv/karst -xf -
cd /srv/karst
npm ci
npm run -s build
VSCODE_BIN="$(flock /vscode-cache/.karst-download.lock node scripts/uat-host/run.mjs --print-vscode | tail -1)"
KARST_TARGET_APP_BINARY="$VSCODE_BIN" npm run -s rebuild:electron
export UAT_VSCODE_BIN="$VSCODE_BIN"
exec node scripts/uat-host/serveServer.mjs "$@"
