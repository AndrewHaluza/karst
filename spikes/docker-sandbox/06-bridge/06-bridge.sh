#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
S="${SPIKE_PREFIX}claude"; ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"; D="$ROOT/wt-a/.karst-spike"
echo "== Candidate C: append-only file, single-clock round trip (20 pings, 10 ms host poll)" | tee -a "$LOG"
mkdir -p "$D"; : > "$D/ping.ndjson"; : > "$D/pong.ndjson"
# responder runs in the sandbox; its pid file lives in the sandbox so we only stop what we started
run sbx exec "$S" sh -c "nohup sh -c 'echo \$\$ > /tmp/responder.pid; tail -n0 -F \"$D/ping.ndjson\" | while read -r l; do echo \"\$l\" >> \"$D/pong.ndjson\"; done' >/dev/null 2>&1 &"
sleep 2
run node "$SPIKE_DIR/06-bridge/poll-events.mjs" "$D" 20
run sbx exec "$S" sh -c 'kill $(cat /tmp/responder.pid) 2>/dev/null; echo responder-stopped'
echo "== Host receiver DOWN: sandbox emits 5 events with no host poller running; host reads them afterwards" | tee -a "$LOG"
: > "$D/down.ndjson"
run sbx exec "$S" sh -c "for i in 1 2 3 4 5; do echo down-\$i >> '$D/down.ndjson'; done"
sleep 1
run sh -c "wc -l < '$D/down.ndjson'; cat '$D/down.ndjson' | tr '\n' ' '"
echo "== Candidate B: sandbox -> host loopback relay" | tee -a "$LOG"
node -e "require('http').createServer((q,r)=>r.end('ok')).listen(19090,'127.0.0.1')" & R=$!; sleep 1
run sbx exec "$S" sh -c "curl -s --max-time 4 -o /dev/null -w 'host.docker.internal:19090 -> %{http_code}\n' http://host.docker.internal:19090/"
kill $R
