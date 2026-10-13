#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"
ROOT="${TMPDIR:-/tmp}/karst-spike-ws"; ROOT="${ROOT%/}"
x() { run sbx exec "$S" sh -c "$1"; }
x "echo inside > '$ROOT/wt-a/written-in-sandbox.txt'"
run test -f "$ROOT/wt-a/written-in-sandbox.txt"
x "cat '$ROOT/wt-b/seed.txt'"
x "echo x > '$ROOT/wt-b/pwn.txt'"
x "ln -s / '$ROOT/wt-a/escape' && ls '$ROOT/wt-a/escape/Users'"
x "ls \"\$HOME\"; ls /Users 2>&1; ls '$HOME/Library/Application Support/Code/User/globalStorage/karst.karst' 2>&1"
x "cat '$ROOT/wt-a/.git'; git -C '$ROOT/wt-a' log --oneline -1 2>&1"
run test ! -e "$ROOT/wt-b/pwn.txt"
rm -f "$ROOT/wt-a/escape"
