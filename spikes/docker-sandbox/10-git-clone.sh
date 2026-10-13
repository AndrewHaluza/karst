#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
ROOT="${TMPDIR:-/tmp}"; ROOT="${ROOT%/}/karst-spike-ws"; S="${SPIKE_PREFIX}clone"
run sbx create --clone --name "$S" claude "$ROOT/repo"
run sbx exec "$S" sh -c 'pwd; git status --short | head; git log --oneline -1; echo clone-edit > clone.txt; git add clone.txt; git -c user.email=a@a -c user.name=a commit -qm clone-commit; git log --oneline -2'
run git -C "$ROOT/repo" remote -v
run git -C "$ROOT/repo" branch -a
