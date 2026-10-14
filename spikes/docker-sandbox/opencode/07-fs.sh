#!/usr/bin/env bash
# Exp 7: worktree + shared git common dir bind mounts. Usage: 07-fs.sh <scratch-dir>
set -u
S=${1:?scratch dir}; rm -rf "$S"; mkdir -p "$S"; S=$(cd "$S" && pwd -P)
git init -q "$S/repo" && git -C "$S/repo" -c user.name=h -c user.email=h@x commit -q --allow-empty -m init
git -C "$S/repo" worktree add -q "$S/wt" -b feat
mkdir -p "$S/sibling"; echo secret > "$S/sibling/s.txt"; echo hostfile > "$S/outside.txt"
COMMON="$S/repo/.git"
# Bind mounts keep host uid/gid on Linux: run as the host user so the image's
# `node` (uid 1000) is not denied writes to a runner-owned (uid 1001) checkout.
U="--user $(id -u):$(id -g) -e HOME=/tmp"
echo "## .git pointer: $(cat "$S/wt/.git")"
run() { docker run --rm "$@" oc-spike; }
echo "## A: worktree only (ST2 condition 1 reproduction)"
docker run --rm $U -v "$S/wt:$S/wt" -w "$S/wt" oc-spike git status 2>&1 | head -2
echo "## B: worktree + common dir at same abs paths"
docker run --rm $U -v "$S/wt:$S/wt" -v "$COMMON:$COMMON" -w "$S/wt" oc-spike sh -c '
 git config --global --add safe.directory "*"
 git status -sb | head -2
 echo hi > a.txt && git add a.txt && git -c user.name=agent -c user.email=a@x commit -q -m agent-commit && git log --oneline | head -2
 echo "-- write outside:"; echo x > '"$S"'/outside.txt 2>&1; echo "rc=$?"
 echo "-- sibling read:"; cat '"$S"'/sibling/s.txt 2>&1 | head -1
 echo "-- write /etc,/:"; touch /etc/x 2>&1; echo rc=$?'
echo "## host sees commit on branch feat:"; git -C "$S/repo" log feat --oneline | head -2
echo "## C: hooks exposure — agent plants hook in shared .git (rw common dir)"
docker run --rm $U -v "$S/wt:$S/wt" -v "$COMMON:$COMMON" -w "$S/wt" oc-spike sh -c 'printf "#!/bin/sh\necho PWNED > '"$S"'/hook-ran.txt\n" > '"$COMMON"'/hooks/post-commit; chmod +x '"$COMMON"'/hooks/post-commit; echo planted'
git -C "$S/repo" -c user.name=h -c user.email=h@x commit -q --allow-empty -m host-commit; echo "host hook ran? $(cat "$S/hook-ran.txt" 2>&1)"
rm -f "$S/hook-ran.txt" "$COMMON/hooks/post-commit"
echo "## D: hardened — hooks + config mounted ro over rw common dir"
docker run --rm $U -v "$S/wt:$S/wt" -v "$COMMON:$COMMON" -v "$COMMON/hooks:$COMMON/hooks:ro" -v "$COMMON/config:$COMMON/config:ro" -w "$S/wt" oc-spike sh -c '
 git config --global --add safe.directory "*"
 echo hook > '"$COMMON"'/hooks/post-commit 2>&1; echo "hook write rc=$?"
 git config --local core.hooksPath /tmp/x 2>&1 | head -1
 echo b > b.txt && git add b.txt && git -c user.name=agent -c user.email=a@x commit -q -m c2 && echo "commit still ok"'
