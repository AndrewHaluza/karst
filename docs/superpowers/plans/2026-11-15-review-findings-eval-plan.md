# Plan: review-findings pass for `eval:form` (2026-11-15)

Goal: measure the review findings call site (Lane B) with known-defect diffs. A deterministic check scores each run. No model judge scores the result.

Base: the harness exists on `develop` (`evals/`, `scripts/evalForm/`), not on this branch. Do the work in a new worktree from `develop`. Copy this plan to `docs/superpowers/plans/` there.

## [@plan:REVEVAL-01] Scope

- In scope: one pass, `--pass review`. It calls the real `buildFindingsPrompt` and `parseFindingsResult` from `src/workflow/review/`.
- Out of scope: the review fix loop, the UAT tester, classify, and `npm run eval` (Docker). Do not change production code under `src/`.
- Rule: compare results only within one case-set version. Record the build SHA in `results.json`.

END_DOC_BLOCK: [@plan:REVEVAL-01]

## [@plan:REVEVAL-02] Case format

One directory for each case: `evals/form/review-cases/<id>/`.

- `case.json`: `{ id, title, baseRef, branch, defects: [...], cleanFiles: [...] }`.
- A defect: `{ id, file, lineStart, lineEnd, kind, minSeverity }`. `kind` is one of `bug`, `security`, `regression`.
- `repo/base/`: the source tree at the base commit. `repo/change/`: the files that the seeded change adds or replaces. The runner commits `base/` on `main` (message `base`). It then copies `change/` over it and commits on the case branch (message `change`). A defect `file` is a path relative to the tree root with no `./` prefix. The lines refer to the file after the change. The defect `id` must be a string that cannot occur in code, for example `REVEVAL-D-001`.
- Cases: 10 at version 1. Six hold one seeded defect. Two hold two defects. Two are clean diffs, which measure false findings.
- Seeded defects are hand-written and small (a TypeScript file under 80 lines). Do not mine real tickets. Do not use private code.
- Answer-key rule: the seeded code has no comment that names a bug. The runner copies only `repo/` into the checkout. It never copies `case.json`.

END_DOC_BLOCK: [@plan:REVEVAL-02]

## [@plan:REVEVAL-03] Checker (deterministic)

File: `scripts/evalForm/reviewChecks.mjs`.

1. A finding matches a defect when the file is equal and the finding line is in `[lineStart - 3, lineEnd + 3]`. A finding with no line does not match.
2. Each defect matches at most one finding. The first match in output order wins.
3. Per run, output: `found`, `missed`, `falseFindings` (findings that match no defect), `blockingFalse` (false findings at `high` or `critical`), `parseTier`, `shape`.
4. Per case with no defect, `falseFindings` above zero is a failure.
5. The coverage entry that the prompt requires is not a finding. The runner removes it with `splitCoverage(stripCoverageLabel(rawFindings))` from `src/model/coverageRecord.ts`. It does not remove the entry by hand.
6. The checker is a pure function. It does no parse, no coverage split, and no git call. It scores the already-parsed findings from the runner against the defects. It only matches.
7. The runner (REVEVAL-04) owns the parse, the coverage split, and the checkout drop. The pass scores the same output as the lane. After the parse, the runner copies the lane guard `parsed.some(isWrongCheckoutClaim)` (`findingsLane.ts:484`). When the guard is true, the runner calls `verifyCheckout(git, worktreePath, branch)` (`checkoutClaim.ts:54`, as in `findingsLane.ts:485`). `verifyCheckout` needs an async `GitRunner` that returns `{ exitCode, stdout }` (`src/integrations/git.ts:41`). Use `defaultGitRunner` from `src/integrations/git.ts:265`. Do not use the `gitRunner` in `scripts/evalForm/draftChecks.mjs`. That function is sync and returns a string. The runner then calls `dropDisprovenCheckoutClaims(findings, verdict, { branch, repo, warn })` (`checkoutClaim.ts:88-92`). This function does not run git. It takes the verdict.
8. The runner result holds `shape` and `droppedCheckoutClaims`, the count of dropped claims. The checker copies both into its output.

END_DOC_BLOCK: [@plan:REVEVAL-03]

## [@plan:REVEVAL-04] Runner

File: `scripts/evalForm/reviewRun.mjs`. Pattern: `planRun.mjs`.

1. Make a temporary git checkout for each run from `repo/`. Make it in `os.tmpdir()`. Copy only `repo/`, never `case.json`. Use generic commit messages, for example `base` and `change`. Never use the case `title` or a defect id in a commit message. Remove it after the parse, the coverage split, and the checkout drop (items 5 and 5a). The probe needs the checkout.
2. Checkout rules: HEAD is on the case branch. A local `main` exists. A local bare repository is the `origin` remote. It sits in `os.tmpdir()`, outside the work tree. The runner pushes `main` and the case branch to it. `snapshotRef` is null. `openChanges` is false. The prompt diff command `git diff origin/main...origin/<branch>` (`src/workflow/agentScope.ts:201-205`) then works on the first try, as in production. The runner removes the bare repository with the checkout.
3. Call the review like production (`findingsLane.ts:403-441`). Build the prompt with all 11 arguments: `buildFindingsPrompt(repo, baseRef, branch, undefined, false, null, checkoutPath, 'high', undefined, undefined, structuredOutputFormOf(adapter))`. The arguments `artifacts` and `gates` are none.
4. Call `adapter.runHeadless` with `prompt`, `cwd` set to the checkout, `model`, optional `effort`, `timeoutMs`, `policy: 'reviewer'`, and `tracking.callSite` set to `eval-form-review`. Add `outputSchema: REVIEW_OUTPUT_SCHEMA` only when `adapter.surfaces?.structuredOutput?.supported === true`. Do not set `allowedTools`.
5. Parse with `parseFindingsResult(raw, { repo, worktreePath, max }, warn, onTier, finalMessage)`. Use the real `ctx` and pass `result.finalMessage`.
5a. Do the coverage split and the checkout drop here, as REVEVAL-03 items 5 and 7 describe. Do them BEFORE the checkout removal in item 1.
6. Return `{ status: ok|timeout|error, findings, tier, shape, droppedCheckoutClaims, usage }`. The `findings` are final: parsed, split, and dropped. Never throw for a run failure.
7. Run cases one at a time. Repeat each case `--runs N` times.
8. The parse of the flags `--models`, `--provider`, `--effort`, `--only`, `--runs`, `--max-calls` already exists in `run.mjs`. Add `--cases-dir`. The validation does not exist for the review pass. `run.mjs` checks `--runs` only on the generic path (`run.mjs:91`), after the `plan` and `draft` early returns. It checks `--max-calls` only in `validateRejudge` (`run.mjs:115`).
9. Add `review` to `PASSES`. Add a `validateReview` branch, like `plan` and `draft`, before the generic validate path. The generic path requires `--model` and `--judge-model`. `validateReview` must validate `--runs` and `--max-calls` itself. `--runs` is a positive integer. `--max-calls` is a positive integer or unset. `reviewRun` must stop when the call count reaches `maxCalls`. Add a dispatch line next to the existing ones in `main`.

END_DOC_BLOCK: [@plan:REVEVAL-04]

## [@plan:REVEVAL-05] Report

File: `scripts/evalForm/reviewReport.mjs`. Output: `eval-results/review-<ts>/report.md` and `results.json`.

- One table row for each candidate (core, model, effort): recall (`found / seeded defects`), false findings per clean case, `blockingFalse` count, error and timeout count, tokens per run, wall time.
- Rates show a Wilson 95% interval. A cell with n below 30 shows INSUFFICIENT.
- Print the exact command, the case-set version, the build SHA, and the core versions.
- Do not rank candidates when n is below 30.

END_DOC_BLOCK: [@plan:REVEVAL-05]

## [@plan:REVEVAL-06] Tasks (test first)

Add the tests to a new file, `scripts/evalForm/review.integration.test.mjs`. Each pass has its own test file (`plan.test.mjs`, `draft.test.mjs`, `intent.test.mjs`). The file `plan.test.mjs` shows how to build tmp git repos with `execFileSync`.

1. Write the failing test for `reviewChecks.mjs` (match, no double match, clean case, copy of `shape` and `droppedCheckoutClaims`). Then write the code.
2. Write the failing test for `reviewRun.mjs` with a fake adapter. The adapter returns scripted raw answers. Add tests for the coverage entry drop and the checkout drop with `droppedCheckoutClaims`. Then write the code.
2a. Write a test for the checkout rules: HEAD is on the case branch, local `main` exists, `origin` is a local bare repository outside the work tree, `origin` holds `main` and the case branch, `git diff origin/main...origin/<branch>` succeeds in the checkout, `snapshotRef` is null, `openChanges` is false.
2b. Write a test for answer-key leakage. Scan the work tree of the checkout and exclude `.git/`. No file in the work tree contains a defect id, the `title`, or any free-text field of `case.json`. Do not scan paths, numbers, `kind` words, or severities, because the seeded repo legitimately holds them. Exempt the `branch` and `baseRef` values. The test also checks that the commit messages hold no `title` and no defect id. The checkout is in `os.tmpdir()`.
3. Write the failing test for `reviewReport.mjs` (Wilson interval, INSUFFICIENT flag). Then write the code.
4. Wire `--pass review` in `run.mjs`. Add a test for argument validation. Add a test that `validateReview` rejects an invalid `--runs` and an invalid `--max-calls`. Add a test that `reviewRun` stops when the call count reaches `maxCalls`.
5. Write the 10 cases. Add a test that each case builds a git repo, and that the base and branch differ.
6. Run `npm run test:unit` and the script tests. Update the README and add `@arch:FORMEVAL-REVIEW` in `docs/arch/prompt-metrics.md`. Update the coverage matrix row.
7. Smoke run with the fake adapter. Do not call a real agent in this plan.

END_DOC_BLOCK: [@plan:REVEVAL-06]

## [@plan:REVEVAL-07] First real run (needs user approval of budget)

- Candidates: the default preset of `claude`, `antigravity` and `opencode2`.
- Command: `--provider` takes one value. Make three invocations, one for each core.
- Size: 10 cases, 1 run, so 30 calls. Run one case first and report the tokens before the rest.
- Success: the pass runs end to end and the report shows recall and false findings for each candidate.
- Do not draw a conclusion from n below 30 for a single cell.

END_DOC_BLOCK: [@plan:REVEVAL-07]
