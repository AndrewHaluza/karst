#!/usr/bin/env bash
# Credential-free subset for a Linux host / CI runner with Docker (exps 1, 7, 8, 9).
# Linux-specific extra: bind-mounted files keep host uid/gid, so run with --user "$(id -u):$(id -g)".
set -eu
cd "$(dirname "$0")"
docker build -t oc-spike .
docker run --rm oc-spike sh -c 'opencode1 --version; opencode2 --version; git --version; node -v'
./07-fs.sh "$(mktemp -d)/x"
W=$(mktemp -d); echo "import http from 'node:http';http.createServer((q,r)=>r.end('uat-ok')).listen(8123,'0.0.0.0')" > "$W/srv.mjs"
docker run -d --name ocdev -p 127.0.0.1:18123:8123 -v "$W:/work" oc-spike node /work/srv.mjs >/dev/null; sleep 2
curl -s -m 4 http://127.0.0.1:18123/; echo; docker rm -f ocdev >/dev/null
docker run --rm --network none oc-spike sh -c 'curl -s -m 4 https://registry.npmjs.org/ >/dev/null && echo LEAK || echo network-blocked'
