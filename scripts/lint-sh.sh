#!/usr/bin/env bash
# Lint every tracked *.sh at info severity (SC2086 is info); spikes/** only get `bash -n`
# (throwaway scripts that source each other, so shellcheck flags cross-file
# variables). Locally a missing shellcheck is a notice (exit 0); CI=true makes
# it a failure.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

status=0
while IFS= read -r f; do
  bash -n "$f" || status=1
done < <(git ls-files 'spikes/*.sh')

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "lint:sh: shellcheck not installed (brew install shellcheck / apt install shellcheck); skipped." >&2
  [ "${CI:-}" = "true" ] && exit 1
  exit "$status"
fi

files=()
while IFS= read -r f; do files+=("$f"); done < <(git ls-files '*.sh' ':!:spikes/**')
shellcheck --severity=info "${files[@]}" || status=1
exit "$status"
