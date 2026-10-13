#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"; ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"
EV="$ROOT/wt-a/.karst-spike/events.ndjson"
x() { run sbx exec "$S" sh -c "$1"; }
x "printf '{\"ticket\":\"T1\",\"stage\":\"impl\",\"event\":\"impl-complete\"}\n' >> '$EV'"
x "printf '{\"ticket\":\"T2\",\"stage\":\"done\",\"event\":\"impl-complete\"}\n' >> '$EV'"
echo "-- host sees BOTH lines (file is agent-writable; host must bind ticket by path, not by line content):" | tee -a "$LOG"
run tail -2 "$EV"
x "ls '$ROOT'/ 2>&1; ls '$ROOT/../' 2>&1 | head -3"
x "env | grep -iE 'karst' || echo no-karst-env"
x "find / -xdev \\( -name '*.sqlite' -o -name '*.sqlite3' -o -name 'karst*.db' -o -name '*.db' \\) -not -path '/proc/*' -not -path '/usr/*' -not -path '/home/agent/.codex/*' -not -path '/home/agent/.claude/*' 2>/dev/null | head"
