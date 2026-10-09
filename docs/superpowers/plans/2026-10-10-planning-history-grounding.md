# Planning History Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every planning session's instructions carry a bounded per-repo history snapshot (recent base commits + docs/arch keys) and a pre-proposal checklist.

**Architecture:** `planningInstructions` stays pure and renders an optional `history` input. A host-side gatherer (`src/extension/ops/planningHistory.ts`, injected async git runner, node fs for docs) builds it at launch; failures degrade to omission and a debug line. `planningOps` takes the gatherer as an optional dep; `extension.ts` binds it.

**Tech Stack:** TypeScript ESM, vitest, node:child_process `execFile` (async — no spawnSync).

**Spec:** ticket PLANNING-GROUND-THE-PLANNER-IN brief (`karst context PLANNING-GROUND-THE-PLANNER-IN`).

## Global Constraints
- Max 12 commits per repo; each commit line truncated to 90 chars; section ≤1500 chars per repo; overflow keys → `… and N more`.
- `git -C <repoPath> log --oneline -12 <base> --` (trailing `--` mandatory).
- Keys only from `## [@arch:KEY]` headings — never block bodies.
- Repos sharing a repoPath gathered once. Failure never blocks launch.
- Existing contract text unchanged; debug line adds `history <n>c`.

---

### Task 1: Render history + checklist in preamble (pure)
**Files:** Modify `src/planning/preamble.ts`; Test `src/planning/preamble.test.ts`
**Produces:** `PlanningRepoHistory { repo: string; base: string; commits: string[]; archKeys: { file: string; keys: string[] }[] }`, `PreambleInput.history?`, `historySection(history): string[]`, `PLANNING_HISTORY_MAX_CHARS = 1500`, `PLANNING_HISTORY_MAX_COMMITS = 12`.
- [ ] Tests: full history renders commits + `- prompt-metrics.md: RESIDENT, GUIDEGATE`; no history → no section; repo without archKeys → commits only; 1500-char bound with `… and N more`; checklist text present before draft contract.
- [ ] Run `npx vitest run src/planning/preamble.test.ts` → FAIL; implement; → PASS; commit.

### Task 2: Gatherer
**Files:** Create `src/extension/ops/planningHistory.ts`; Test `src/extension/ops/planningHistory.test.ts`
**Produces:** `gatherPlanningHistory(manifest, deps: { runGit(args: string[]): Promise<string>; debug? }): Promise<PlanningRepoHistory[]>`, `execGit` real runner.
- [ ] Tests (fake runner + temp dir): args end with `--`; lines truncated to 90; monorepo dedupe; git failure → commits [] and debug; missing docs/arch → archKeys [].
- [ ] FAIL → implement → PASS → commit.

### Task 3: Wiring + debug size
**Files:** Modify `src/extension/ops/planningOps.ts`, `src/extension.ts`; Test `src/extension/ops/planningOps.test.ts`
- [ ] Dep `planningHistory?: (m: PlanningManifest) => Promise<PlanningRepoHistory[]>`; rejection → debug, launch continues. Debug line gains `history <n>c`.
- [ ] Test: injected history appears in instructions file; rejecting gatherer still launches.

### Task 4: Code pointers + arch doc
- [ ] 2-line header comments in `src/agent/seed.ts`, `src/agent/entrySeed.ts`, `src/context/ticketContext.ts`.
- [ ] New keyed block `[@arch:PLANNING-HISTORY]` in `docs/arch/cli.md` after CLI-13.
- [ ] Full unit suite, typecheck, stryker on changed `src/extension/**` files; commit.
