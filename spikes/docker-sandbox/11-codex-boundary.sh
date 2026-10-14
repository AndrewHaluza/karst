#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}codex"; ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"
x() { run sbx exec "$S" sh -c "$1"; }
x "echo inside-codex > '$ROOT/wt-b/written-by-codex-sandbox.txt'"
run test -f "$ROOT/wt-b/written-by-codex-sandbox.txt"
x "cat '$ROOT/wt-a/seed.txt'"
x "echo x > '$ROOT/wt-a/pwn-codex.txt'"
x "ls /Users 2>&1; ls \"\$HOME\""
x "env | grep -iE 'openai|anthropic|token|key' | sed -E 's/=.{6}.*/=<redacted>/' || echo none"
x "docker info --format '{{.Name}} {{.ID}}' 2>&1 | head -2"
x "curl -s --max-time 3 -o /dev/null -w '%{http_code}\n' http://host.docker.internal/ 2>&1"
x "ls -l \"\$HOME/.codex/auth.json\"; wc -c < \"\$HOME/.codex/auth.json\""
run ps -o args= -p 1
x "ps -eo args | grep -E 'codex' | grep -v grep | head -3 || echo no-codex-process"
run test ! -e "$ROOT/wt-a/pwn-codex.txt"
