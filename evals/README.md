# Eval task set

Pinned, versioned subset of a public TypeScript SWE-bench-style benchmark, used
by the eval report (D293). Upstream curation is reused as-is: issue texts,
`FAIL_TO_PASS` / `PASS_TO_PASS` and gold patches come from the dataset. Karst's
own PRs are not mined, and instances are never edited.

- Pinned set: `instances/multi-swe-bench-ts-v1.jsonl`, 18 instances (see `instances/MANIFEST.md` for source, commit, selection rule).
- Compare results only **within one set version**. A new version is a new file.

## Setup and check

```sh
npm run -s eval:setup        # clones the pinned harness into evals/.harness + python venv (needs docker, python 3.11-3.13)
npm run -s eval:check-set    # gold patch on every pinned instance; lists drifted ones
npm run -s eval:check-set -- --control          # no-op patch must come back unresolved
npm run -s eval:check-set -- --runs 3 --only vuejs/core:pr-11813
```

`eval:check-set` writes `evals/reports/check-set-{gold,control}.json` (gitignored) and
exits 1 when any instance drifted. A drifted instance (gold patch not resolved
on every run) is **excluded from scoring** and must be listed in the D293 report.
Images are removed after each instance (`--keep-images` to keep them).

## Spike: which set (decided 2026-10-31)

Both upstream harnesses were run directly (no karst runner) on an arm64 Mac,
Docker Desktop (6 CPU / 6.7 GiB), gold patch vs. negative control.

| | Multi-SWE-bench (TS part) | SWE-PolyBench (TS) |
|---|---|---|
| TS instances | 224: vuejs/core 48, mui/material-ui 174, darkreader 2 | 729 (Verified split: 100) — mui 488, vscode 205, tailwind 20, code-server 14, angular 2 |
| Human-validated label | Every TS instance is in the harness's `images_verified.txt` list | Separate `SWE-PolyBench_Verified` split, 100 TS (70 mui, 23 vscode) |
| Image size per instance | ~3.2 GB (shared 1.9 GB base layer) | ~8.8 GB each, no layer sharing seen |
| Image arch | amd64 only (emulated on arm64) | amd64 only (emulated on arm64) |
| Gold, spike instances | vuejs/core#11813 resolved | mui 18257, 20732 resolved (2/2) |
| Negative control | empty patch: unresolved (see note); no-op patch: tests run (~70 s), unresolved | not run |
| Install friction | python 3.14+ breaks it; `Qiskit`/`qiskit` dirs collide on macOS | `requirements.txt` pins numpy/scikit-learn that break `pyarrow`; needs a manual bump |

**Choice: Multi-SWE-bench.** Smaller images (a 15–20 instance set fits in disk
at once; PolyBench would need ~150 GB), a repo mix beyond MUI (Vue core), and the
harness takes plain patch files per instance, so the check script is a thin wrapper.
PolyBench's Verified split is 93 % mui/vscode and vscode images are the heaviest.

Notes and caveats:

- **amd64 emulation.** Every image is `linux/amd64`; Docker Desktop emulates it on Apple
  silicon. A vue-core instance took ~50 s of test time, a no-op control ~70 s, plus ~30 s image pull. Expect a
  slow, noisy wall clock; do not use timings to compare agents.
- **Empty patch** is "unresolved" only because `git apply` rejects an empty file and no tests run
  (`error_msg: no test results`). The control used here is a **no-op patch** (adds one empty file) so the
  real test run happens and F2P tests fail.
- **Harness setup patches** (done by `scripts/evalSetupHarness.sh`): the upstream repo has both
  `harness/repos/python/Qiskit/` and `.../qiskit/`, which collide on a case-insensitive filesystem, so the
  python-only Qiskit imports are removed. No effect on TS instances.
- **Network.** Prebuilt images already contain the installed dependencies (pnpm/npm registry only; harness
  Dockerfiles use `apt install git/jq`, `npm install -g pnpm`, `git clone` of the project repo).
  The test run itself is not sandboxed offline; no instance needed anything beyond the package registry.
- **Contamination.** Older public instances (MUI, Vue PRs up to 2024) may be in model training data.
  A SWE-bench-Live TS slice can be added later as a separate set version.
- **Row size.** Upstream rows carry the dataset builder's three result logs (`run_result`,
  `test_patch_result`, `fix_patch_result`), which the harness validates as non-null. Rows over 3 MB were not
  selected to keep the pinned file small.
