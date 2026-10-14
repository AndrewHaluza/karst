#!/usr/bin/env bash
set -eu
ROOT="${TMPDIR:-/tmp}/karst-spike-ws"
rm -rf "$ROOT"; mkdir -p "$ROOT/repo"
git -C "$ROOT/repo" init -q -b main
echo seed > "$ROOT/repo/seed.txt"
git -C "$ROOT/repo" add . && git -C "$ROOT/repo" -c user.email=s@s -c user.name=s commit -qm seed
git -C "$ROOT/repo" worktree add -q "$ROOT/wt-a" -b a
git -C "$ROOT/repo" worktree add -q "$ROOT/wt-b" -b b
echo "WT_A=$ROOT/wt-a"; echo "WT_B=$ROOT/wt-b"
