#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"; S="${SPIKE_PREFIX}gitmount"
# worktree gitdir is /private/var/...; mount the shared .git at BOTH spellings via the realpath
REAL="$(cd "$ROOT/repo/.git" && pwd -P)"
run sbx create --name "$S" claude "$ROOT/wt-a" "$REAL"
run sbx exec "$S" sh -c "cd '$ROOT/wt-a' && git status --short | head -3; git log --oneline -1"
run sbx exec "$S" sh -c "cd '$ROOT/wt-a' && echo mounted > m.txt && git add m.txt && git -c user.email=a@a -c user.name=a commit -qm via-mount && git log --oneline -2"
echo "-- host view of branch a (commit should be visible):" | tee -a "$LOG"
run git -C "$ROOT/repo" log --oneline -2 a
echo "-- exposure: can the sandbox modify shared metadata (other branch, hooks, config)?" | tee -a "$LOG"
run sbx exec "$S" sh -c "cd '$ROOT/wt-a' && git branch -f b HEAD && echo hook > '$REAL/hooks/post-commit' && echo wrote-hook"
run git -C "$ROOT/repo" log --oneline -1 b
run ls -l "$REAL/hooks/post-commit"
echo "-- exposure (separate commands): hook write, non-checked-out branch overwrite" | tee -a "$LOG"
run sbx exec "$S" sh -c "echo '#!/bin/sh' > '$REAL/hooks/post-commit' && chmod +x '$REAL/hooks/post-commit' && echo wrote-hook"
run ls -l "$REAL/hooks/post-commit"
run sbx exec "$S" sh -c "cd '$ROOT/wt-a' && git branch -f other HEAD && echo moved-other-branch"
run git -C "$ROOT/repo" log --oneline -1 other
rm -f "$REAL/hooks/post-commit"
