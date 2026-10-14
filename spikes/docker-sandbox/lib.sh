#!/usr/bin/env bash
# Disposable spike helper. Not production code.
set -u
SPIKE_PREFIX=karst-spike-
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${LOG:-$SPIKE_DIR/logs/$(basename "$0" .sh).log}"
mkdir -p "$SPIKE_DIR/logs"
: > "$LOG"
run() {
  echo "\$ $*" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  echo "[exit $rc]" | tee -a "$LOG"
  return "$rc"
}
