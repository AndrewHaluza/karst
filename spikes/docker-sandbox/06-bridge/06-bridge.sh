#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
S="${SPIKE_PREFIX}claude"; ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"
EV="$ROOT/wt-a/.karst-spike/events.ndjson"; rm -rf "$ROOT/wt-a/.karst-spike"
echo "== Candidate C: host polls append-only file (20 events, 200ms apart)" | tee -a "$LOG"
node "$SPIKE_DIR/06-bridge/poll-events.mjs" "$EV" 20 > "$SPIKE_DIR/logs/06-C.result" &
P=$!; sleep 1
run sbx exec "$S" sh -c "mkdir -p '$ROOT/wt-a/.karst-spike'; for i in \$(seq 20); do printf '{\"ticket\":\"T1\",\"stage\":\"impl\",\"event\":\"phase\",\"ts\":%s}\n' \$(python3 -c 'import time;print(int(time.time()*1000))') >> '$EV'; sleep 0.2; done"
wait $P; cat "$SPIKE_DIR/logs/06-C.result" | tee -a "$LOG"
echo "== Host receiver DOWN behaviour for C: events simply persist in file (append-only)" | tee -a "$LOG"
echo "== Candidate B: relay on host loopback, reached from sandbox" | tee -a "$LOG"
node -e "require('http').createServer((q,r)=>{r.end('ok')}).listen(19090,'127.0.0.1')" & R=$!; sleep 1
run sbx exec "$S" sh -c "curl -s --max-time 4 -o /dev/null -w 'host.docker.internal:19090 -> %{http_code}\n' http://host.docker.internal:19090/; curl -s --max-time 4 -o /dev/null -w 'gateway -> %{http_code}\n' http://\$(ip route | awk '/default/{print \$3}'):19090/"
kill $R
