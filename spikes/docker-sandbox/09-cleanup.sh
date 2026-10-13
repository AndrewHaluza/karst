#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"
S="${SPIKE_PREFIX}claude"
t() { local s=$(python3 -c 'import time;print(time.time())'); "$@"; python3 -c "import time;print('[elapsed %.1fs]'%(time.time()-$s))"; }
echo canary > "$ROOT/canary.txt"; C1=$(shasum "$ROOT/canary.txt")
# Unrelated sandbox (NOT karst-spike- prefixed) must survive cleanup.
BYSTANDER=bystander-spike-check
run sbx create --name "$BYSTANDER" shell "$ROOT/wt-b"
run sbx ls
run du -sh "$HOME/Library/Application Support/com.docker.sandboxes"
run t sbx stop "$S"
run t sbx exec "$S" true            # restart-on-exec latency
# Remove ONLY sandboxes whose name starts with the spike prefix (claude, codex, clone, gitmount, ...).
for n in $(sbx ls 2>/dev/null | awk -v p="$SPIKE_PREFIX" 'NR>1 && index($1,p)==1 {print $1}'); do
  run sbx stop "$n"; run sbx rm --force "$n"
done
run sbx ls                          # expect: only the bystander
run ls "$ROOT/wt-a"                 # worktree changes remain
run sh -c "[ \"\$(shasum '$ROOT/canary.txt')\" = '$C1' ] && echo canary-untouched"
run sh -c "sbx ls | grep -c '$BYSTANDER'"
run sbx rm --force "$BYSTANDER"     # test fixture, removed explicitly by exact name
run du -sh "$HOME/Library/Application Support/com.docker.sandboxes"
