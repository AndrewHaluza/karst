#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"
x() { run sbx exec "$S" sh -c "$1"; }
x "env | grep -iE 'anthropic|openai|token|key' || echo none"
x "find / -xdev \\( -name '.credentials.json' -o -name auth.json \\) 2>/dev/null | head"
x "docker info --format '{{.Name}} {{.ID}}' 2>&1 | head -3"
run docker info --format '{{.Name}} {{.ID}}'
x "ls -l /var/run/docker.sock 2>&1"
x "curl -s --max-time 3 -o /dev/null -w '%{http_code}\n' http://192.168.0.1/ 2>&1; curl -s --max-time 3 -o /dev/null -w '%{http_code}\n' http://host.docker.internal/ 2>&1"
