#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"; ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"
t() { local s=$(python3 -c 'import time;print(time.time())'); "$@"; python3 -c "import time;print('[elapsed %.1fs]'%(time.time()-$s))"; }
echo canary > "$ROOT/canary.txt"; C1=$(shasum "$ROOT/canary.txt")
run sbx ls
run du -sh "$HOME/Library/Application Support/com.docker.sandboxes"
run t sbx stop "$S"
run t sbx exec "$S" true            # restart-on-exec latency
run sbx stop "$S"
run sbx rm --force "$S"
run sbx ls
run ls "$ROOT/wt-a"                 # worktree changes remain
run sh -c "[ \"\$(shasum '$ROOT/canary.txt')\" = '$C1' ] && echo canary-untouched"
run du -sh "$HOME/Library/Application Support/com.docker.sandboxes"
