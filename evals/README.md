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

## Run the eval

```sh
npm run eval -- --instances evals/instances/multi-swe-bench-ts-v1.jsonl --variant default --runs 3 --eval-env ANTHROPIC_API_KEY
npm run eval -- --instances <file.jsonl> --fake-core --only <id>   # adapter smoke, KARST_FAKE_CORE=1, no scoring
```

Needs the harness (`npm run eval:setup`), a built `dist/` (`npm run build`), Docker, and credentials by env-var NAME or `--eval-auth-dir`. Output lands in `eval-results/<ts>/report.md`
(resolved rate, pass@k, spread, pairwise deltas, cost/time per resolved task, blocked and timeout counts, set version, core versions); see `docs/arch/uat-host.md` UATHOST-05.
Variants are `evals/variants/<name>.json` (`provider`, `gates`); `default` is built in. Runs are sequential and slow: budget hours, not minutes.

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

## Ticket-form improve eval (`eval:form`)

Offline, no Docker: scores the ticket form's description-improve pass (`improveDescription`) under one or more prompt sources. See `@arch:FORMEVAL` in `docs/arch/prompt-metrics.md`.

```sh
npm run eval:form:export -- --db <karst.db> --sample 20 --seed 1   # optional: private own tickets -> evals/form/local/ (gitignored)
npm run eval:form -- --prompt builtin --prompt .karst/agents/description-improver.md \
  --model <id> --judge-model <other-id> --runs 3 \
  [--cases evals/form/improve-cases.jsonl --cases evals/form/local/own-tickets.jsonl] [--only id,id] [--provider claude|codex]
```

Output: `eval-results/form-<ts>/report.md` and `results.json`. Edit a candidate prompt file and rerun to compare columns.

Draft pass (accepted planning drafts vs the diff that landed; private input, gitignored):

```sh
npm run eval:form:export -- --pass draft --db <karst.db> --sample 30 --seed 1 [--project <slug>]
npm run eval:form -- --pass draft --db <karst.db> --judge-model <id> --repo <manifest-repo>=<clone path> [--only draftId,draftId]
```

Reports notDone / unrequested per draft, static defect rate by kind, truncation count, split by planning core/model, and per-draft downstream outcome (n < 10 = LOW, no correlation claim).

Planner bench (real planner, headless, public issues; see `@arch:FORMEVAL-PLAN`): `npm run eval:form -- --pass plan --models <a,b> --judge-model <id> [--effort <level>] [--judge-provider <id>] [--judge-effort <level>] [--only id] [--timeout-min 10] [--max-drafts 3] [--plan-extra <file.md>] [--publish]`; output `eval-results/plan-<ts>/`. Results and comparisons: `evals/form/PLANNER-MODEL-RATINGS.md`. CAUTION: `--publish` replaces that whole file, including the tables that are kept by hand. `results.json` does not record `--effort` or `--plan-extra`, so write down the full command for each run. Saved planner runs are in `evals/form/plan-references/`. Do not put them in `evals/form/references/`, because `--rejudge` cannot read plan results.

Re-score saved runs with one blind judge (no producer call): `npm run eval:form -- --rejudge evals/form/references --judge-model claude-opus-5-5 [--dry-run] [--max-calls N]`; output `eval-results/rejudge-<ts>/report.md`.

## AI capability coverage (2026-11-06)

This matrix shows the AI capabilities of karst and their eval state. The list comes from `src/agent/aiCallSites.ts`, the process roles, the preset capabilities, and the conflict session. Other paths, such as `ciFailure.ts`, were not checked for separate AI use.

Legend for the model columns (Opus 5.5, Sonnet 5.5, Haiku 5.5, Non-Claude). Each symbol has one meaning:

| Symbol | Meaning |
|---|---|
| ✅ | A saved result exists for at least one effort level. The effort is known. |
| ⚠️ | A saved result exists, but the effort is not confirmed. |
| ❌ | No saved result exists. |

The Non-Claude column names the models that have a result. For this column, ✅ does not confirm the effort, because the effort of these runs was not checked.

Legend for the other columns:

| Column | Value | Meaning |
|---|---|---|
| Should evaluate? | Yes, high | The output controls later work or a verdict. |
| | Yes | The output has an effect on the ticket, but it does not control later work or a verdict. |
| | Optional | The capability is opt-in, gives a warning only, or has a small effect. |
| Eval tool | A pass name, such as `intent` | Use `npm run -s eval:form -- --pass <name>`. |
| | `npm run eval` | The full pipeline can exercise this capability. No run exists. |
| | None | No eval tool exists. |

| Stage | Capability | Should evaluate? | Eval tool | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 | Non-Claude |
|---|---|---|---|---|---|---|---|
| Ticket form | Classify (approach, repos, type) | Yes, high | None | ❌ | ❌ | ❌ | ❌ |
| | Description improve | Yes | `improve` | ❌ | ⚠️ | ⚠️ | ✅ Gemini, GPT, Mimo, DeepSeek |
| | Intent (test charter) | Yes, high | `intent` | ✅ | ✅ | ✅ | ✅ Gemini |
| | Code pointers (opt-in) | Optional | None | ❌ | ❌ | ❌ | ❌ |
| | Signal suggestion | Optional | None | ❌ | ❌ | ❌ | ❌ |
| Planning | Planning session | Yes, high | `plan`, `draft` | ✅ | ✅ | ✅ | ✅ Gemini |
| | Artifact alignment (warn only) | Optional | None | ❌ | ❌ | ❌ | ❌ |
| Implementation | Implementation session | Yes, high | `npm run eval` | ❌ | ❌ | ❌ | ❌ |
| Review | Review findings | Yes, high | None | ❌ | ❌ | ❌ | ❌ |
| | Review fix | Yes | `npm run eval` | ❌ | ❌ | ❌ | ❌ |
| UAT | UAT tester | Yes | None | ❌ | ❌ | ❌ | ❌ |
| | UAT fix | Yes | `npm run eval` | ❌ | ❌ | ❌ | ❌ |
| Ship | PR description | Optional | None | ❌ | ❌ | ❌ | ❌ |
| | Conflict resolution session | Yes | None | ❌ | ❌ | ❌ | ❌ |
| Graph | Graph planner | Yes | None | ❌ | ❌ | ❌ | ❌ |
| | Graph node (expert, worker, fast) | Yes | None | ❌ | ❌ | ❌ | ❌ |

- The "Should evaluate?" values are a judgment, not a rule.
- The Opus low, Sonnet high, and Haiku medium intent results are in `evals/form/references/`. The judge changes these scores more than the model does, so do not rank the models from them. See section 1a of `evals/form/INTENT-MODEL-RATINGS.md`.
- A ✅ does not mean that the capability is fully evaluated. Only Opus low and Sonnet high have repeat planner runs.
- The `npm run eval` entries come from the design of the pipeline. Check which stages `buildSteps` runs, and if a variant can set the model and effort. This eval gives one result for the full pipeline, not a score for each capability.
- The improve cells for Sonnet and Haiku show ⚠️ because `results.json` records no effort for those runs.

### Possible next steps

The order is a recommendation. It puts existing tools and high-value capabilities first.

| Order | Step | Capability | Work needed |
|---|---|---|---|
| 1 | Do not add more intent runs of the same kind. Check the judges against labels from a person, or add cases with more hidden tests. | Intent | New labels or new cases |
| 2 | Add a pass that gives known-defect diffs to the reviewer, and counts the defects that it finds and the false findings. | Review findings | New pass and new cases |
| 3 | Add a pass that compares the classify output with the known approach, repos, and type. | Classify | Small new pass and new cases |
| 4 | Run `npm run -s eval:setup`. Check which stages `buildSteps` runs, and if a variant can set the model and effort. Then run `npm run eval` on 2 or 3 instances. | Implementation, review fix, UAT fix | Harness setup, possibly variant changes |
| 5 | Record the effort for the improve pass in `results.json`, and pass `--judge-effort` to the improve judge in `scripts/evalForm/run.mjs`. Then run the improve pass for Opus, Sonnet, and Haiku. | Description improve | Small code change |
| 6 | Make `--rejudge` read plan results, and score the Opus and Sonnet planner runs with one judge. | Planning | Small code change |
| 7 | Design evals for the conflict resolution session, the UAT tester, the graph planner, and the graph node. | These 4 capabilities | New design and new cases |
| 8 | Add evals for the optional capabilities only if a real problem occurs. | Code pointers, signal suggestion, artifact alignment, PR description | None for now |

