#!/usr/bin/env bash
# Installs the pinned upstream Multi-SWE-bench harness into evals/.harness
# (gitignored): a clone at the pinned commit plus a python venv.
#
# Two upstream problems are worked around here (see evals/README.md):
#  1. the repo has both `python/Qiskit/` and `python/qiskit/`; on a
#     case-insensitive filesystem (macOS default) they collide and the harness
#     fails to import. The python-only Qiskit imports are removed (no TS effect).
#  2. python 3.14+ breaks the harness dataclasses; use python 3.11-3.13.
set -euo pipefail

HARNESS_COMMIT=24f493f8a103e72312ded4f6b9c89f081d69cb09
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/evals/.harness"
PY="${EVAL_PYTHON:-python3.11}"

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
command -v "$PY" >/dev/null || { echo "$PY not found (set EVAL_PYTHON to python 3.11-3.13)" >&2; exit 1; }

mkdir -p "$DIR"
if [ ! -d "$DIR/msb/.git" ]; then
  git clone -q https://github.com/multi-swe-bench/multi-swe-bench.git "$DIR/msb" 2>/dev/null || true
fi
git -C "$DIR/msb" fetch -q --depth 1 origin "$HARNESS_COMMIT"
git -C "$DIR/msb" checkout -q -f "$HARNESS_COMMIT"
sed -i.bak -E '/repos\.python\.[Qq]iskit import/d' "$DIR/msb/multi_swe_bench/harness/repos/python/__init__.py"
rm -f "$DIR/msb/multi_swe_bench/harness/repos/python/__init__.py.bak"

"$PY" -m venv "$DIR/venv"
"$DIR/venv/bin/pip" -q install -e "$DIR/msb"
"$DIR/venv/bin/python" -c "import multi_swe_bench.harness.run_evaluation" >/dev/null
echo "harness ready: $DIR/venv/bin/python (msb@$HARNESS_COMMIT)"
