# Execution Plan: Reconcile SEED-28's implementation with the corrected entry-point-commands target

## Goal

**This plan is self-contained. Every fact it depends on is stated below. Do NOT try to open
any other plan file: the plan files named in this document are untracked in a different
checkout, are NOT on this branch, and their absence is expected and is not a blocker.**

The branch `karst/feat/seed-28-entry-point-commands-split-the-human-facing-session` ends in
this state: four entry-point
orchestrators (start-task, resume, fix, resolve-conflict) materialized per core in that
core's OWN artifact shape and invocation form, declared through `AdapterSurfaces`, with the
done-marker resident inline in every seed, no per-ticket aliases, generated opencode command
FILES excluded from git, and the seed-shape logic in a vscode-free module.

## Current State

**Why this plan exists.** Ticket 463's description was overwritten by the stage promotion to
`impl` at 13:25:37, which replaced the corrected plan with the superseded
`docs/plans/2026-09-09-start-task-command-seed-split.md` (named for the record only — do not
look for it, it is not on this branch) and spilled it to
`attachments/463/a567893cc2982f0b.txt`. The executor session launched at 13:25:39 read that
and is implementing the superseded plan. It is a deterministic worker with no replanning
capability, so it will run all 15 superseded tasks to completion.

**The worktree is a MOVING TARGET while that session runs.** At the time of writing:
`.karst/worktrees/seed-28-entry-point-commands-split-the-human-facing-session`, no commits,
~2,725 insertions across 20 modified + 4 new files, `src/extension.ts` last written 17:24:25.
This plan is therefore written against the superseded plan's SPECIFIED END STATE — which is
fully determined and known — not against the partial files present right now.

**What the superseded plan produces that is CORRECT and must be kept:**
- `sections` mode on `renderTicketContext` (superseded T1 ≡ corrected T1).
- `renderStageEnding` + `## How this stage ends` in `karst context` (superseded T2 ≡ corrected T2).
- `src/cli/fixBriefCommand.ts`, `src/cli/conflictBriefCommand.ts`, wired at
  `src/cli/main.ts:314` and `:325`, with both verbs named in the unknown-verb message at `:337`.
- The four body renderers in `src/agent/workflowCommand.ts`: `renderStartTaskCommand`,
  `renderResumeCommand`, `renderFixCommand`, `renderResolveConflictCommand`, plus
  `RESERVED_BASENAMES`, `START_TASK_BASENAME`, `RESUME_BASENAME`, `FIX_BASENAME`,
  `RESOLVE_CONFLICT_BASENAME` and the four `*_DESCRIPTION` constants.
- claude's and opencode's artifact paths and invocation strings (`/karst:start-task` and
  `/karst-start-task`). These two cores are correct.

**What the superseded plan produces that is WRONG:**

- **D1 — the done-marker becomes non-resident.** Superseded Key Decision 2 and T9 step 5:
  `const useStartTask = Boolean(startTaskInvocation)`; when true, `buildSessionSeed` receives
  `null` for `markerInstruction`, and the orchestrator body carries the marker instead, with
  a fallback for when materialization did not happen.
- **D2 — `src/runtime/karstExcludes.ts` is never touched.** The superseded plan contains zero
  references to it. Line 50 is `'/.opencode/commands/karst-*/'` — trailing slash, directories
  only. The generated artifacts are `.md` FILES.
- **D3 — per-ticket aliases are emitted.** Superseded T13 adds
  `MaterializeOpts.aliasTickets`, a `ticketKey?: string` parameter on three renderers, and
  `<basename>-<KEY>.md` files in every adapter.
- **D4 — the adapter contract is an undeclared optional string.** Superseded T4 adds
  `Materialized.startTaskInvocation?: string`. No `AdapterSurfaces` entry, so a core that
  cannot host an orchestrator drops it silently.
- **D5 — antigravity gets a `commands/` directory it does not read.** Superseded Key
  Decision 6 says "command file for claude/antigravity/opencode, skill for codex". Verified
  false for antigravity: `src/agent/antigravity.ts:241,264` writes its generated orchestrator
  as a SKILL at `.agents/plugins/karst/skills/<idSlug>/SKILL.md`, and `:294` emits the
  invocation as `${slugCommandName(opts.pkg.id)}` — a `$`-prefixed form. Antigravity has no
  `commands/` directory at all. The worktree already contains
  `mkdirSync(join(karstDir, 'commands'), …)` and
  `startTaskInvocation = \`/${KARST_PLUGIN_NAME}:${START_TASK_BASENAME}\``, both wrong.
- **D6 — no vscode-free seed module.** Superseded T9 puts the seed-shape logic directly in
  `src/extension.ts`, which imports `vscode` and does not load under vitest (CLAUDE.md).
- **D7 — `AGENT_GUIDE` is never updated.** The superseded plan has zero references to
  `AGENT_GUIDE` or `guide.test.ts`. Superseded T10 adds two CLI verbs.
  `src/cli/guide.test.ts:16-21` pins the accepted verb list.

**Verified per-core invocation and artifact forms** (these are the authority for Tasks 5–6):

| core | artifact | path | invocation |
|---|---|---|---|
| claude | command | `.karst-plugin/karst/commands/<basename>.md` | `/karst:<basename>` (`claude.ts:370`) |
| opencode | command | `.opencode/commands/karst-<basename>.md` | `/karst-<basename>` (`opencode.ts:979`) |
| antigravity | **skill** | `.agents/plugins/karst/skills/<slug>/SKILL.md` (`:241,264`) | **`$<slug>`** (`:294`) |
| codex | **skill** | via `skillDocument()` (`codex.ts:294-306`) | **`$karst-<idSlug>`** (`:513`, `prefix` at `:398`) |

Other facts this plan depends on:
- `docs/arch/prompt-metrics.md:226-227`: "Marker rule, done-means-merged: resident. The
  agent's default model of the world is wrong in a specific way; the text corrects it before
  the mistake."
- `src/runtime/karstExcludes.ts:41-47` records the precedent: the unexcluded generated
  `karst-bridge.js` FILE "was staged by ship's `git add -A`, committed, and conflicted with
  every worktree's regenerated copy on every merge." The `plugins` rule at line 53 carries no
  trailing slash for exactly this reason.
- `OWNED_PREFIXES` (`src/agent/materializedCleanup.ts:11-20`) governs session-cleanup
  DELETION, not git exclusion. Separate mechanism.
- `src/agent/surfaces.ts`: `SurfaceSupport`, `SUPPORTED`, `unsupported(reason)`,
  `AdapterSurfaces`; declared optional on the adapter, REQUIRED of every adapter
  `registry.ts` resolves, enforced by `adapterConformance.test.ts`.
- `codex.ts:294-306` `skillDocument(name, description, body)` prepends its own
  `---`/`name:`/`description:`/`---`. A renderer emitting frontmatter recreates the
  double-block defect PROMPT-01 fixed.
- `src/context/ticketContext.ts:234`: `TicketContext.stageCurrent` is `string | null`, not
  `StageKey | null`. `src/extension.ts:6162` casts.
- `materializeApproach` runs at `src/extension.ts:~6235`, roughly 90 lines AFTER the seed is
  composed at `~6143`.

## Target State

- Every launch, resume, fix and conflict seed contains the inline done-marker,
  unconditionally, with no predicate gating it and no fallback rule anywhere.
- The four orchestrator bodies contain operational context only: no marker prose, no
  frontmatter, no `$ARGUMENTS`-substituted per-ticket variants.
- `Materialized.entryInvocations` carries the four invocations; `startTaskInvocation` no
  longer exists. `AdapterSurfaces.entryOrchestrators` is declared by all four adapters and
  checked by `adapterConformance.test.ts`.
- Antigravity writes skills and emits `$`-prefixed invocations; codex likewise. Claude and
  opencode keep their command files and slash invocations.
- `.opencode/commands/karst-*.md` FILES are git-excluded.
- Seed-shape logic lives in `src/agent/entrySeed.ts`, vscode-free and unit-tested;
  materialization runs before seed composition in `src/extension.ts`.
- `AGENT_GUIDE` documents `fix-brief` and `conflict-brief`; `guide.test.ts` pins both.
- The four architecture docs describe the shipped design, with no marker-fallback rule.

## Scope

### In Scope
- Removing the marker-omission predicate and its fallback (D1).
- The `karstExcludes` file rule (D2).
- Deleting the alias machinery (D3).
- Replacing `startTaskInvocation` with `entryInvocations` + the declared surface (D4).
- Correcting antigravity's artifact shape and invocation, and verifying codex's (D5).
- Extracting `src/agent/entrySeed.ts` and reordering materialization (D6).
- `AGENT_GUIDE` + `guide.test.ts` (D7).
- The four architecture docs.

### Out of Scope
- Reverting the branch or re-implementing anything listed as correct above.
- `renderTicketContext`'s `sections` mode and `karst context`'s stage-ending output — already correct.
- `src/cli/fixBriefCommand.ts` / `conflictBriefCommand.ts` and their `main.ts` wiring — already correct.
- The three graph-planner seeds (`src/extension.ts:3865`, `4232`, `4732`) and `sessions.nudge`
  (`~:744`).
- `renderWorkflowCommand` and the existing per-approach workflow command.
- Ticket-key autocomplete in any form.
- Any DB schema change or migration. This plan touches no persistent state.

## Key Decisions

1. **Execute only after the running executor session has finished.** Two writers on one
   worktree corrupt each other. Task 0 is a gate that establishes quiescence before anything
   else runs.
2. **Keep the renderers, replace the seam.** The four body renderers are correct work; only
   their `ticketKey?` alias parameter and any marker prose are wrong. Do not rewrite them.
3. **Marker residency is fixed first**, because it is the only defect that silently prevents
   tickets from advancing — an agent that never sees the marker never fires
   `karst stage <k> pass`, and the stage hangs with no error.
4. **Aliases are deleted, not repaired.** They require committing generated files and leave
   stale files no cleanup path reaches. Their removal is why `karstExcludes` alone suffices.
5. **Each core keeps its own convention.** Do not unify artifact shape across cores; the
   four-adapter seam rule (`docs/arch/agent-cores.md`) forbids inventing a namespace a core
   does not have.

## Execution Order

### Task 0: Establish that the worktree is quiescent

#### Objective
Prove the superseded-plan executor has stopped before editing anything it may still be writing.

#### Files
None modified.

#### Implementation
0. You are running INSIDE the target worktree; it is your own working directory. The purpose
   of this gate is to confirm no OTHER writer is active and to take a revertible baseline
   before you change anything. If `git status` shows the ~25 uncommitted files described in
   `## Current State`, that is the expected starting point, not a problem.
1. Work in the current directory. Where this plan writes `git -C "$W"`, plain `git` is
   equivalent — do not change directories.
2. Record the current file-modification fingerprint:
   ```bash
   git -C "$W" status --porcelain | sort > /tmp/seed28-a.txt
   ```
3. Wait 120 seconds, then repeat into `/tmp/seed28-b.txt`.
4. Compare. If the two differ, the executor is still writing: STOP and report that
   Task 0's precondition is unmet. Do not proceed.
5. If identical, capture a baseline commit so every later task is revertible:
   ```bash
   git -C "$W" add -A && git -C "$W" commit -m "wip: superseded-plan implementation, pre-reconciliation baseline"
   ```

#### Constraints
- Do not `git stash` — the stash stack is shared across worktrees and other sessions.
- Do not force-push or reset. The baseline commit is additive.

#### Edge Cases
- The two listings differ → STOP, per step 4. This is a legitimate blocker.
- `git commit` reports nothing to commit → the worktree is already clean; proceed.

#### Verification
```bash
diff /tmp/seed28-a.txt /tmp/seed28-b.txt && echo QUIESCENT
git -C "$W" log --oneline -1
```

Expected:
- `QUIESCENT` printed.
- One baseline commit exists on the branch.

#### Completion Criteria
- [ ] Two status listings 120s apart are byte-identical.
- [ ] A baseline commit exists.

### Task 1: Restore the done-marker as resident in every seed

#### Objective
Remove the marker-omission predicate and its fallback so the inline done-marker appears in
every seed unconditionally.

#### Files
- `src/extension.ts` — the seed-composition site (`~:6143`–`~:6281`); holds `useStartTask`.
- `src/agent/workflowCommand.ts` — the four renderers, if any emits marker prose.
- `src/agent/seed.test.ts` — assertions that pin marker omission.

#### Implementation
1. Current behavior: `const useStartTask = Boolean(startTaskInvocation);` and, at the
   `buildSessionSeed` call, the marker argument is `useStartTask ? null : markerInstruction`.
   Required behavior: `buildSessionSeed` always receives the rendered `markerInstruction`
   for the ticket's marker stage, on every entry point.
2. Delete the `useStartTask` binding and every use of it as a marker predicate. Where it also
   selected `sections: 'narrative' | 'all'`, keep that selection but drive it from whether an
   entry invocation exists — the narrative/operational split is correct and is not being
   reverted. Only the MARKER must stop depending on it.
3. Delete the fallback rule (superseded Key Decision 2) wherever it is stated in code
   comments. There is no fallback because there is no omission.
4. Inspect each of `renderStartTaskCommand`, `renderResumeCommand`, `renderFixCommand`,
   `renderResolveConflictCommand`. Remove any sentence instructing the agent to fire
   `karst stage … pass` or describing the done marker. The bodies keep only operational
   context and the `karst context` / `karst guide` / brief-command pointers.
5. `## How this stage ends`, emitted by `karst context`, stays exactly as implemented. It is
   a RE-READ path, never the primary carrier.
6. In `seed.test.ts`, replace any case asserting "with an invocation and no marker … does NOT
   contain the marker text" with its inverse: with an invocation present, the seed DOES
   contain the marker text. Add one case per entry point (launch, resume, fix, conflict)
   asserting marker presence.

#### Constraints
- Do not change `renderDoneMarkerInstruction`'s text or signature.
- Do not change `buildSessionSeed`'s signature or section order.
- Do not revert the narrative/operational `sections` split.

#### Edge Cases
- Gate stage (`markerStageFor` returns null) with an orchestrator materialized → no marker
  text exists to insert; the seed carries none, exactly as today. This is stage-driven
  absence, not materialization-driven omission, and is correct.
- Materialization did not happen at all → seed is composed as it is on `develop` today.
- Resume and conflict paths → marker appended, per corrected plan Task 14.

#### Verification
```bash
npx vitest run src/agent/seed.test.ts
grep -rn "useStartTask" src/
npm run typecheck
```

Expected:
- Tests green.
- The `grep` prints nothing.
- Typecheck clean.

#### Completion Criteria
- [ ] `grep -rn "useStartTask" src/` is empty.
- [ ] No code path passes `null` for `markerInstruction` on the basis of materialization.
- [ ] No orchestrator body mentions the done marker.
- [ ] `seed.test.ts` asserts marker presence for all four entry points.

### Task 2: Exclude generated opencode command FILES from git

#### Objective
Stop `.opencode/commands/karst-*.md` from being staged by ship's `git add -A`.

#### Files
- `src/runtime/karstExcludes.ts` — `KARST_EXCLUDE_RULES`, the rule at line 50.
- `src/runtime/karstExcludes.test.ts` — new case.

#### Implementation
1. Current behavior: line 50 is `'/.opencode/commands/karst-*/'`. The trailing slash makes
   git match directories only, so a generated `karst-start-task.md` file is not excluded.
2. Required behavior: both the directory form and the generated `.md` files are excluded.
3. Change line 50 to carry no trailing slash: `'/.opencode/commands/karst-*'`. This mirrors
   the `plugins` rule at line 53 (`'/.opencode/plugins/karst-*'`), which drops its slash for
   exactly this reason. Do NOT add a second rule; one slashless pattern covers both.
4. Extend the comment block at lines 41-47 to say the commands rule now drops its slash for
   the same reason as plugins: generated command FILES, not only directories.
5. Add a test case asserting `.opencode/commands/karst-start-task.md` is excluded, and one
   asserting a repository's own `.opencode/commands/mine.md` is NOT excluded.

#### Constraints
- Do not modify `OWNED_PREFIXES` in `src/agent/materializedCleanup.ts` — it governs deletion,
  not exclusion, and is out of scope.
- Do not change the `skills` or `agents` rules.

#### Edge Cases
- A repository's own non-prefixed opencode command → must remain unexcluded (asserted).
- An existing `karst-*/` directory → must remain excluded (existing test must still pass).

#### Verification
```bash
npx vitest run src/runtime/karstExcludes.test.ts
```

Expected:
- New and existing cases green.

#### Completion Criteria
- [ ] `.opencode/commands/karst-start-task.md` is excluded.
- [ ] `.opencode/commands/mine.md` is not excluded.
- [ ] The pre-existing directory-rule test still passes.

### Task 3: Delete the per-ticket alias machinery

#### Objective
Remove superseded T13 in full.

#### Files
- `src/agent/adapter.ts` — delete `MaterializeOpts.aliasTickets`.
- `src/agent/workflowCommand.ts` — delete the `ticketKey?: string` parameter from
  `renderResumeCommand`, `renderFixCommand`, `renderResolveConflictCommand` and the branch
  that suppresses the `$ARGUMENTS` grammar.
- `src/agent/claude.ts`, `src/agent/opencode.ts`, `src/agent/antigravity.ts`,
  `src/agent/codex.ts` — delete the alias-emitting loops.
- `src/extension.ts` — delete the code supplying the ticket list to `aliasTickets`.
- `src/agent/*.test.ts`, `src/agent/workflowCommand.test.ts` — delete alias assertions.

#### Implementation
1. Delete the `aliasTickets` field and its docstring from `MaterializeOpts`.
2. In each adapter, delete the block introduced with the comment "Per-ticket alias files for
   the manual-recovery commands" (and its opencode equivalent), including the
   `<basename>-<KEY>` filename construction and its `writeGeneratedArtifact` call.
3. In the three renderers, delete the `ticketKey` parameter and restore the unconditional
   `$ARGUMENTS` grammar paragraph. Each renderer takes only the command-pointer fields named
   in the corrected plan's Task 5.
4. In `src/extension.ts`, delete the query and the array construction that existed only to
   populate `aliasTickets`.
5. Delete every test that asserts an alias file is written or that a renderer suppresses
   `$ARGUMENTS` when given a key.
6. Because aliases wrote files into session dirs during development, remove any that exist:
   ```bash
   find . -path '*/commands/*-[A-Z]*.md' -newer package.json
   ```
   Delete only files matching a `<basename>-<TICKET-KEY>.md` shape under a generated
   `commands/` or `skills/` directory. Do not delete the four canonical orchestrators.

#### Constraints
- Do not delete the four canonical orchestrator artifacts or their renderers.
- Do not remove `RESERVED_BASENAMES` or the basename constants.
- Do not change `writeGeneratedArtifact` or `withStamp`.

#### Edge Cases
- An adapter that never implemented aliases → nothing to delete there; not an error.
- A renderer whose `ticketKey` parameter is already unused → still delete the parameter.

#### Verification
```bash
grep -rn "aliasTickets\|ticketKey" src/agent/
npx vitest run src/agent/workflowCommand.test.ts
npm run typecheck
```

Expected:
- The `grep` prints no `aliasTickets`, and no `ticketKey` inside `src/agent/`.
- Tests green, typecheck clean.

#### Completion Criteria
- [ ] `aliasTickets` does not appear anywhere in `src/`.
- [ ] No adapter writes a `<basename>-<KEY>` file.
- [ ] The three renderers emit the `$ARGUMENTS` grammar unconditionally.

### Task 4: Replace `startTaskInvocation` with `entryInvocations` and declare the surface

#### Objective
Carry four invocations instead of one, and make a core that cannot host orchestrators declare
that rather than drop it silently.

#### Files
- `src/agent/adapter.ts` — `Materialized`, `MaterializeOpts`.
- `src/agent/surfaces.ts` — `AdapterSurfaces`.
- `src/agent/claude.ts`, `opencode.ts`, `antigravity.ts`, `codex.ts` — produce
  `entryInvocations`; declare the surface.
- `src/agent/adapterConformance.test.ts` — require the declaration.
- `src/extension.ts` — consume `entryInvocations`.
- The four adapter test files.

#### Implementation
1. Current behavior: `Materialized` carries `startTaskInvocation?: string`, set by each
   adapter to a single string. Required behavior: `Materialized` carries
   `entryInvocations` — a readonly record keyed by the four basenames, each value the
   core's own invocation string, absent when that orchestrator was not materialized.
2. Delete `startTaskInvocation` from `Materialized`. Add, after `invocation`:
   ```ts
   /** The invocation each generated entry orchestrator registered, in this core's OWN
    *  namespace — `/karst:<basename>` on claude, `/karst-<basename>` on opencode,
    *  `$<slug>` on antigravity and codex. A basename is absent when that orchestrator
    *  was not materialized. Absent entirely when the core declares
    *  `entryOrchestrators` unsupported. */
   readonly entryInvocations?: Readonly<Partial<Record<EntryBasename, string>>>;
   ```
   with `EntryBasename` a union of the four basename literals, exported from
   `workflowCommand.ts` beside the existing basename constants.
3. Add to `AdapterSurfaces`, following the existing field style:
   ```ts
   /** The adapter materializes the four entry-point orchestrators (start-task, resume,
    *  fix, resolve-conflict) in its own artifact shape and reports their invocations. */
   readonly entryOrchestrators: SurfaceSupport;
   ```
4. All four adapters declare `entryOrchestrators: SUPPORTED`. None declares
   `unsupported(...)`: all four can host the artifacts. The field exists so a FIFTH core
   must answer it.
5. Update `adapterConformance.test.ts` so an adapter missing `entryOrchestrators` fails,
   matching how the suite already treats the other surfaces.
6. In `src/extension.ts`, read the entry invocation for the current entry point from
   `entryInvocations` instead of `startTaskInvocation`.

#### Constraints
- Do not change `extraArgs`, `invocation`, or `ownedPaths` on `Materialized`.
- Any new `MaterializeOpts` field is optional, so existing callers and test fakes compile.
- `AdapterSurfaces` stays an optional member on the adapter; the conformance suite is what
  makes it mandatory for resolvable adapters.

#### Edge Cases
- An adapter that materialized nothing → `entryInvocations` absent; the seed carries no
  invocation and, per Task 1, still carries the marker.
- A test fake implementing `AgentAdapter` without surfaces → still compiles, by design.
- Only some basenames materialized → only those keys present.

#### Verification
```bash
grep -rn "startTaskInvocation" src/
npx vitest run src/agent/adapterConformance.test.ts
npm run typecheck
```

Expected:
- The `grep` prints nothing.
- Conformance suite green; typecheck clean.

#### Completion Criteria
- [ ] `startTaskInvocation` appears nowhere in `src/`.
- [ ] `Materialized.entryInvocations` exists and is documented.
- [ ] All four adapters declare `entryOrchestrators`.
- [ ] `adapterConformance.test.ts` fails an adapter that omits it.

### Task 5: Correct antigravity's artifact shape and invocation

#### Objective
Antigravity currently writes a `commands/` directory it does not read and reports a
slash-namespaced invocation it does not resolve. Both must match its real convention.

#### Files
- `src/agent/antigravity.ts` — materialization block.
- `src/agent/antigravity.test.ts` — path and invocation assertions.

#### Implementation
1. Current behavior: `mkdirSync(join(karstDir, 'commands'), { recursive: true })`, files
   written to `join(karstDir, 'commands', \`${entry.basename}.md\`)`, and
   `startTaskInvocation = \`/${KARST_PLUGIN_NAME}:${START_TASK_BASENAME}\``.
2. Required behavior: each orchestrator is a SKILL at
   `.agents/plugins/karst/skills/<basename>/SKILL.md`, matching the generated-orchestrator
   path this adapter already uses at `antigravity.ts:241,264`; the reported invocation is
   `$<basename>`, matching the form at `:294`.
3. Delete the `mkdirSync(join(karstDir, 'commands'), …)` call and the `commands` path
   segment. Write each orchestrator through the same skill-writing path the existing
   generated orchestrator uses, with `<basename>` as the skill directory name.
4. Frontmatter stays adapter-owned and hand-built, exactly as at `antigravity.ts:256-263`.
   The renderer output is the BODY appended after it.
5. Set the `entryInvocations` entry for each materialized basename to `$<basename>`.
6. Register the written paths in `ownedPaths` as the adapter already does for its generated
   orchestrator, so session cleanup reaches them.
7. Tests: assert the written path ends in `.agents/plugins/karst/skills/start-task/SKILL.md`;
   assert no path containing `/commands/` is written; assert the invocation starts with `$`
   and contains no `:`; assert the artifact contains exactly one `---` frontmatter block.

#### Constraints
- Do not add a `commands/` directory to antigravity under any circumstance.
- Do not move the frontmatter into the renderer.
- Do not change `KARST_PLUGIN_NAME`.

#### Edge Cases
- `plugin.json` writing stays as implemented; it is not command-specific.
- An approach id that slugs to a reserved basename → the existing reservation throw applies
  unchanged.

#### Verification
```bash
npx vitest run src/agent/antigravity.test.ts
grep -n "commands" src/agent/antigravity.ts
```

Expected:
- Tests green.
- The `grep` prints no path-construction use of `commands` (a prose comment is acceptable).

#### Completion Criteria
- [ ] No `commands/` path is written by antigravity.
- [ ] Orchestrators land under `.agents/plugins/karst/skills/<basename>/SKILL.md`.
- [ ] The invocation is `$`-prefixed with no `:`.
- [ ] Exactly one frontmatter block per artifact.

### Task 6: Verify and correct codex's artifact shape and invocation

#### Objective
Same guarantee as Task 5, for codex, plus the double-frontmatter check.

#### Files
- `src/agent/codex.ts` — materialization block.
- `src/agent/codex.test.ts` — assertions.

#### Implementation
1. Required behavior: each orchestrator is written through `skillDocument(name, description,
   body)` (`codex.ts:294-306`), and the reported invocation is `$karst-<basename>`, matching
   the `prefix` form at `:398` and its use at `:513`.
2. Inspect the current implementation. If it writes any path outside the skill path, or emits
   a slash-namespaced invocation, correct it to the above.
3. Confirm the body handed to `skillDocument` contains NO frontmatter: `skillDocument`
   prepends `---`, `name:`, `description:`, `---` itself. If the renderer output is being
   concatenated with a hand-built frontmatter block here, delete the hand-built block.
4. Set the `entryInvocations` entry for each materialized basename to `$karst-<basename>`.
5. Tests: assert the invocation starts with `$` and contains no `:`; assert the generated
   artifact contains exactly ONE `---`-delimited frontmatter block by counting leading
   delimiters.

#### Constraints
- Do not modify `skillDocument`.
- Do not give codex a command namespace.

#### Edge Cases
- Codex has no early return in `materializeApproach` (unlike claude at `:233-235` and
  antigravity at `:206-208`) — do not add one.
- A basename that collides with the approach id slug → the existing reservation check at
  `codex.ts` (`idSlug === base || prefix === \`karst-${base}\``) applies unchanged.

#### Verification
```bash
npx vitest run src/agent/codex.test.ts
npm run typecheck
```

Expected:
- Tests green, including the single-frontmatter assertion.

#### Completion Criteria
- [ ] Codex's invocation is `$`-prefixed with no `:`.
- [ ] Exactly one frontmatter block per generated artifact.
- [ ] No hand-built frontmatter is concatenated before `skillDocument`'s own.

### Task 7: Extract the vscode-free seed module and order materialization first

#### Objective
Make seed-shape decisions unit-testable, and ensure invocations exist before the seed that
references them is composed.

#### Files
- `src/agent/entrySeed.ts` — new.
- `src/agent/entrySeed.test.ts` — new.
- `src/extension.ts` — move logic out; reorder.

#### Implementation
1. Create `src/agent/entrySeed.ts` with three pure exports, per the corrected plan's Task 12:
   - `launchSections(...)` — returns the `sections` mode for a launch seed.
   - `composeResumeSeed(input: {...}): string`
   - `composeConflictSeed(input: {...}): string`
   The marker is NOT these functions' concern: the caller always appends it.
2. Move the seed-shape logic the superseded T9/T14 placed in `src/extension.ts` into these
   functions. `src/extension.ts` keeps only host wiring — store reads, `vscode` calls, and
   the calls into this module.
3. Current ordering: `renderTicketContext` composes the seed at `src/extension.ts:~6143`, and
   `materializeApproach` runs at `~:6235`. Required ordering: the materialization block moves
   ABOVE seed composition, so `entryInvocations` is available when the seed is built. Move
   the block; do not duplicate it.
4. Note the guard at `~:6235`:
   `const matPkg = pkg ?? (soloAgent ? { id: t.approach!, label: t.approach! } : null);`
   A bare `direct` ticket with no package and no solo agent yields `matPkg === null`, so no
   adapter is called and no orchestrator exists. That path composes a seed with no
   invocation, and — per Task 1 — with the marker. Do not widen this guard.
5. Cast `ctx.stageCurrent` explicitly where a `StageKey` is required: it is `string | null`
   (`ticketContext.ts:234`). Mirror `src/extension.ts:6162`.
6. `entrySeed.test.ts`: one case per exported function, plus a case asserting the resume seed
   composes from ticket context rather than the hand-built string the current code uses.

#### Constraints
- `src/agent/entrySeed.ts` must not import `vscode`, `fs`, or the store. Pure string functions.
- Do not touch `src/extension.ts:3865`, `4232`, `4732` (graph planner) or `~:744`
  (`sessions.nudge`).
- Do not change `buildSessionSeed`'s signature.

#### Edge Cases
- Resume with no fix brief → the existing "Continue the in-progress work on ticket …"
  sentence is the fallback text; preserve it.
- Conflict handoff: `src/extension.ts:6281` (`if (options.seedPrompt) seedPrompt = …`)
  overrides everything. Preserve that precedence.
- `matPkg === null` → no invocation, marker present.

#### Verification
```bash
npx vitest run src/agent/entrySeed.test.ts
grep -n "vscode" src/agent/entrySeed.ts
npm run typecheck
```

Expected:
- Tests green.
- The `grep` prints nothing.

#### Completion Criteria
- [ ] `src/agent/entrySeed.ts` exists, imports no `vscode`, and loads under vitest.
- [ ] Materialization precedes seed composition in `src/extension.ts`.
- [ ] The three graph-planner seed sites are unmodified.

### Task 8: Document the two CLI verbs in `AGENT_GUIDE`

#### Objective
`fix-brief` and `conflict-brief` are accepted by `runCli` but absent from the guide, which a
pinned test enforces.

#### Files
- `src/cli/guide.ts` — `AGENT_GUIDE` (`:29`).
- `src/cli/guide.test.ts` — the pinned verb list (`:16-21`).

#### Implementation
1. Add `fix-brief` and `conflict-brief` entries to `AGENT_GUIDE`, in the existing entry
   format and matching the usage strings already documented at `src/cli/main.ts:91` and `:94`:
   `… fix-brief <key> --db <db>` and `… conflict-brief <key> <repo> --db <db>`.
2. Both are read-only verbs: state that they print a brief and mutate nothing.
3. Extend the pinned array in `guide.test.ts:16-21` to
   `['context','stats','stage','phase','graph','node','test','guide','compact','fix-brief','conflict-brief']`,
   matching the unknown-verb message at `src/cli/main.ts:337`.

#### Constraints
- Do not restructure `AGENT_GUIDE` or reorder existing entries.
- Do not change the verbs' behavior.

#### Edge Cases
- If `compact` is already present in both the guide and the pinned list, leave it; the list
  must match `main.ts:337` exactly.

#### Verification
```bash
npx vitest run src/cli/guide.test.ts
```

Expected:
- Green, including the pinned-list case.

#### Completion Criteria
- [ ] Both verbs appear in `AGENT_GUIDE`.
- [ ] The pinned list matches the unknown-verb message in `main.ts:337`.

### Task 9: Update the architecture documents

#### Objective
Make the four binding documents describe what shipped.

#### Files
- `docs/arch/cli.md` — the two new read-only verbs.
- `docs/arch/prompt-metrics.md` — marker residency restated; orchestrators carry no marker.
- `docs/arch/agent-cores.md` — the per-core orchestrator artifact/invocation table.
- `docs/arch/stages-and-gates.md` — `## How this stage ends` as a re-read path.

#### Implementation
1. `cli.md`: add `fix-brief` and `conflict-brief` to the verb list, marked read-only, noting
   both resolve their ticket through `--manifest` like the existing read verbs.
2. `prompt-metrics.md`: leave lines 226-227 as they stand. Add a sentence recording that the
   entry orchestrators deliberately carry NO marker prose, and that the marker is inline in
   every seed regardless of materialization.
3. `agent-cores.md`: add the four-row table from this plan's Current State (core, artifact,
   path, invocation form), and state that `AdapterSurfaces.entryOrchestrators` is the
   declaration a fifth core must answer.
4. `stages-and-gates.md`: state that `karst context` emits `## How this stage ends`, and that
   it is a re-read path — the seed's inline marker remains the primary carrier.

#### Constraints
- Do NOT document a marker fallback rule anywhere. There is none.
- Do not restate the superseded plan's Key Decision 2 in any form.
- Do not alter the committed guide-pull baseline figures in `prompt-metrics.md`.

#### Edge Cases
- If a document already contains a fallback sentence written by the superseded-plan executor
  (its T15), delete that sentence.

#### Verification
```bash
grep -rn "fallback" docs/arch/prompt-metrics.md docs/arch/stages-and-gates.md
npm run test:unit
```

Expected:
- No fallback rule about the marker appears in either document.
- Unit suite green.

#### Completion Criteria
- [ ] All four documents updated.
- [ ] No marker-fallback rule is stated anywhere in `docs/`.

## Final Verification

1. Confirm no superseded-plan identifier survives.
2. Run the full suite and the build.
3. Confirm the generated-artifact exclusion is real by inspecting the rendered exclude file.

Commands:

```bash
grep -rn "startTaskInvocation\|useStartTask\|aliasTickets" src/
npm run typecheck
npm run test:unit
npm run build
```

Expected:
- The `grep` prints nothing.
- Typecheck clean; full unit suite green; build succeeds.

Manual verification, when an extension host is available:
1. Launch a ticket on claude and confirm the seed contains the inline done-marker AND the
   `/karst:start-task` invocation.
2. Launch the same ticket on antigravity and confirm the artifact is a SKILL under
   `.agents/plugins/karst/skills/`, the invocation is `$`-prefixed, and the marker is inline.
3. Run a ship on a ticket with an opencode session and confirm no `.opencode/commands/karst-*`
   file appears in the commit.

If no extension host is available, state that these three checks were not run and rely on the
automated suite.

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them: ESM `.js`
   import suffixes, `noUncheckedIndexedAccess` guards, strict TDD (RED before GREEN), files
   under 400 lines.
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.
14. Do not revert the branch, and do not re-implement anything listed as correct in
    `## Current State`. Do not reintroduce per-ticket aliases or any marker-omission predicate.
15. Never use bare `git stash` / `git stash pop` — the stash stack is shared with other
    worktrees and sessions.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report:

- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
