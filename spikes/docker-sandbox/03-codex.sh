#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
ROOT="${TMPDIR:-/tmp}/karst-spike-ws"
time_cmd() { local s=$(date +%s); "$@"; echo "[elapsed $(( $(date +%s)-s ))s]"; }
run time_cmd sbx create --name "${SPIKE_PREFIX}codex" codex "$ROOT/wt-b"
run sbx ls
cat <<'MSG' | tee -a "$LOG"
MANUAL: same a-f as 02-claude with `sbx run --name karst-spike-codex` (ChatGPT subscription OAuth),
 g. record final codex argv via sbx exec ... ps -eo args | grep codex
NOTE: codex uses wt-b, so exp 4 sibling test must target wt-b from the claude sandbox.
MSG
