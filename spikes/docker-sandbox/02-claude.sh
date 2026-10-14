#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
eval "$(bash "$SPIKE_DIR/fixture.sh")"
time_cmd() { local s=$(date +%s); "$@"; echo "[elapsed $(( $(date +%s)-s ))s]"; }
run time_cmd sbx create --name "${SPIKE_PREFIX}claude" claude "$WT_A"
run sbx ls
run sbx inspect "${SPIKE_PREFIX}claude"
cat <<'MSG' | tee -a "$LOG"
MANUAL (record PASS/FAIL + timing in logs/02-claude.notes.md):
 a. sbx run --name karst-spike-claude   -> subscription OAuth login completes (no API key)
 b. type a prompt; output streams
 c. resize terminal; UI reflows
 d. Ctrl-C interrupts a turn, session survives
 e. exit; re-run same command; reattach works
 f. sbx exec karst-spike-claude pkill claude; re-run with `-- --continue`; conversation resumes
 g. sbx exec karst-spike-claude ps -eo args | grep claude  -> record final argv (open question 4)
MSG
