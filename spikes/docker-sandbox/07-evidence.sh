#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"; ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"
EV="$ROOT/wt-a/.karst-spike/events.ndjson"
x() { run sbx exec "$S" sh -c "$1"; }
rm -f "$EV"
x "mkdir -p '$ROOT/wt-a/.karst-spike'; printf '{\"ticket\":\"T1\",\"stage\":\"phase\",\"event\":\"phase\"}\n{\"ticket\":\"T1\",\"stage\":\"impl\",\"event\":\"impl-complete\"}\n{\"ticket\":\"T2\",\"stage\":\"impl\",\"event\":\"impl-complete\"}\n{\"ticket\":\"T1\",\"stage\":\"done\",\"event\":\"impl-complete\"}\n' >> '$EV'"
echo "-- host verifier for ticket=T1 stage=impl: must accept exactly 1 and reject the other-ticket and other-stage markers (exit 0)" | tee -a "$LOG"
run node "$SPIKE_DIR/06-bridge/verify-events.mjs" "$EV" T1 impl
echo "-- no Karst DB or KARST_* env inside the sandbox" | tee -a "$LOG"
x "env | grep -iE '^KARST' || echo no-karst-env"
x "find / -xdev \\( -name '*.sqlite' -o -name '*.sqlite3' -o -name 'karst*.db' \\) -not -path '/proc/*' 2>/dev/null | head -5; echo scan-done"
