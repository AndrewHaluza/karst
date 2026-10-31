#!/bin/bash
# Shared UAT host entrypoint (base and eval images): build in the container, then run the host under xvfb.
# UAT_PRE_HOST_HOOK (eval image only) is sourced after the build, so the build keeps full network.
if [ -n "$HOST_UID" ] && [ "$HOST_UID" != 0 ]; then
  trap 'find /work -mindepth 1 -maxdepth 1 ! -name node_modules -exec chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" {} +' EXIT
fi
npm ci && npm run -s build \
  && KARST_TARGET_APP_BINARY="$(npm run -s uat:host -- --print-vscode | tail -1)" npm run -s rebuild:electron \
  && { [ -z "$UAT_PRE_HOST_HOOK" ] || . "$UAT_PRE_HOST_HOOK"; } \
  && xvfb-run -a --server-args='-screen 0 1280x800x24' npm run -s uat:host -- "$@"
