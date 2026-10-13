#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"
t() { local s=$(date +%s); "$@"; echo "[elapsed $(( $(date +%s)-s ))s]"; }
run sbx exec "$S" sh -c 'nohup python3 -m http.server 8123 >/tmp/h.log 2>&1 &'
run sleep 2
run sbx ports "$S" --publish 18123:8123
run sbx ports "$S"
run curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:18123/
run t sbx stop "$S"
run sbx ls
run t sbx ports "$S"
run sbx exec "$S" sh -c 'nohup python3 -m http.server 8123 >/tmp/h.log 2>&1 &'
run sleep 2
run curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:18123/
