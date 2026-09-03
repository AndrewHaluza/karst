# Execution Plan: UAT/Review read uncommitted work via a disposable snapshot ref

## Goal

UAT's Tester lane and Review's findings lane are pointed at a git range that **always contains the ticket's full work — committed and uncommitted alike** — without ever mutating the ticket branch, HEAD, or the index.

A worktree whose work is not yet committed must never again produce the observation *"zero commits over base — nothing to UAT"*.

## Current State

Facts established by reading the code. The executor may rely on these.

### The defect

1. `src/workflow/gates/targets.ts:105-116` — target **selection** already handles uncommitted work. Its comment states the project rule verbatim:

   > `// Agents are allowed to leave implementation work uncommitted until ship.`
   > `// Porcelain includes staged, unstaged, and untracked files, so review cannot`
   > `// pass merely because HEAD itself has not moved yet.`

   `hasReviewChanges` runs `git status --porcelain` first and returns `changed: true` when the worktree is dirty. So a dirty-but-uncommitted repo **is** correctly selected as a target.

2. The gap is entirely **downstream of selection**. Once selected, the agent prompt is built by `buildScopeBlock` (`src/workflow/agentScope.ts:114`), which emits a diff range of `origin/<base>...origin/<branch>`. With nothing committed, that range is empty, and the agent correctly reports it has nothing to look at.

3. `src/workflow/uat/tester.ts:297` calls `buildScopeBlock('test', { baseRef, branch, gatesPassed })` — it does **not** pass `openChanges`. `agentScope.ts:104-106` therefore appends the literal text `" (committed changes only — do NOT include uncommitted working-tree changes)"`. This is the direct cause of the reported UAT failure.

4. `src/workflow/review/findingsLane.ts:192` calls `buildScopeBlock('review', { baseRef, branch, openChanges })`. `openChanges` comes from the manifest (`src/manifest/types.ts:430`, `review.openChanges`, default `false`). When `true`, the prompt merely appends `", plus any uncommitted work (\`git status --porcelain\`)"` — prose telling the agent to go look separately, not a single unified range.

### The primitives that already exist

`src/integrations/git.ts` already contains everything needed, built for ship and covered by `src/integrations/git.test.ts` (*"prepares in quarantine without touching live HEAD/index, then lands the exact commit"*, *"prepares and lands the commit from a LINKED worktree, alternating the common object db"*):

- `prepareCommitInQuarantine(git, cwd, quarantineKey, input): Promise<PreparedCommit>` (line 525). Runs, inside an isolated `GIT_INDEX_FILE` + `GIT_OBJECT_DIRECTORY` that alternates the main object db: `read-tree <preHead>` → `add -A` (**tracked and untracked**, honoring `.gitignore`) → `write-tree` → `commit-tree <tree> -p <preHead> -m <message>`. Returns `{ intendedTree, expectedHead }`. Live HEAD, live index, refs and main object db are untouched.
- `promoteQuarantinedObjects(git, cwd, quarantineKey): Promise<boolean>` (line 576). Copies quarantined objects into the main object db. Idempotent.
- `cleanupQuarantine(git, cwd, quarantineKey): Promise<void>` (line 743). Removes only the canonically contained quarantine dir for the exact key.
- `compareAndSwapHeadAndIndex(...)` (line 615) — **this is the only function that lands a commit on the branch. This plan never calls it.**
- `QuarantinePrepareInput` (line 462): `{ preHead: string; message: string; author: PersistedCommitIdentity; committer: PersistedCommitIdentity }`.
- `PersistedCommitIdentity` (line 456): `{ name: string; email: string; at: string }`.
- Quarantine keys are validated against `/^[A-Za-z0-9._-]+$/` (line 431); an invalid key throws.

`src/workflow/stages/ship.ts:171` shows the established identity pattern:

```ts
async function gitIdentity(git: GitRunner, cwd: string): Promise<PersistedCommitIdentity> {
  const name = await git(['config', 'user.name'], cwd);
  const email = await git(['config', 'user.email'], cwd);
  return {
    name: name.exitCode === 0 && name.stdout.trim() ? name.stdout.trim() : 'karst',
    email: email.exitCode === 0 && email.stdout.trim() ? email.stdout.trim() : 'karst@local',
    at: new Date().toISOString(),
  };
}
```

### The wrong-checkout guard (must not be disturbed)

`src/workflow/uat/tester.ts:203` `checkoutBranch(git, cwd)` runs `git rev-parse --abbrev-ref HEAD`. When the answer does not match the target's branch, the run records a deterministic `critical` observation and **skips that target's call entirely** (`tester.ts:384`, detail `'wrong checkout — skipped'`). This guard exists because of incident `869ej1nfb`. Snapshot creation must happen **after** this guard, only for targets that pass it.

## Target State

A new host-agnostic module `src/workflow/reviewSnapshot.ts` creates a **disposable snapshot ref** per target:

```
refs/karst/snapshot/<ticketId>/<repoKey>
```

pointing at a commit whose tree is the worktree's exact current content (committed + staged + unstaged + untracked, `.gitignore` honored) and whose parent is the worktree's current `HEAD`.

The agent prompt's diff range becomes `origin/<base>...<snapshotRef>` (falling back to `<base>...<snapshotRef>`), so one range covers the whole ticket regardless of commit state.

The ticket branch, HEAD, the index and the remote are never written. The ref is deleted when the lane finishes.

- **UAT Tester**: snapshots **unconditionally** for every target that passes the checkout guard.
- **Review findings lane**: snapshots **only when `review.openChanges === true`**, preserving today's committed-only default contract exactly.
- **Snapshot failure is never fatal**: any error falls back to today's branch-based range, emits a debug line, and the lane proceeds.

## Scope

### In Scope

- New module `src/workflow/reviewSnapshot.ts` + colocated `reviewSnapshot.test.ts`.
- `snapshotRef` support in `src/workflow/agentScope.ts` + its tests.
- Wiring in `src/workflow/uat/tester.ts` + its tests.
- Wiring in `src/workflow/review/findingsLane.ts` + its tests.
- One documentation section in `docs/arch/stages-and-gates.md`.

### Out of Scope

- **No database schema change.** The snapshot sha is not persisted to `uat_findings`, `review_findings`, or any other table. Do not add a column. Do not touch `src/store/`.
- **No new manifest field.** `review.openChanges` is reused as-is; its type, schema validator, default and settings UI are untouched.
- **No change to target selection.** `src/workflow/gates/targets.ts` and `src/workflow/uat/targets.ts` are not modified.
- **No change to ship.** `src/workflow/stages/ship.ts` and its saga are not modified.
- **No change to `src/integrations/git.ts`.** Its exports are consumed, never edited.
- **No change to `src/runtime/archive.ts`** or any ref-pruning sweep.
- Pushing the snapshot ref to a remote. It is local-only, always.

## Key Decisions

1. **Snapshot ref, not an auto-commit on the branch.** An auto-commit at UAT would pollute branch history on every send-back→fix→UAT loop and would make a *reviewing* stage mutate the thing it reviews. The snapshot ref observes without reaching back. Rejected alternative recorded here only to stop the executor from "simplifying" it into `git commit`.

2. **`compareAndSwapHeadAndIndex` is never called.** That is the sole function that installs a prepared commit onto HEAD/index. Preparing + promoting + `update-ref` on a `refs/karst/…` name gives a reachable commit with zero branch mutation.

3. **Repo key is a hash, not a sanitized path.** `createHash('sha256').update(canonicalPath(repoPath)).digest('hex').slice(0, 16)`. Guaranteed to satisfy the quarantine key pattern `/^[A-Za-z0-9._-]+$/` and to be a legal git ref segment, with no escaping rules to get wrong.

4. **UAT snapshots unconditionally; review snapshots only under `openChanges`.** UAT exists to exercise the ticket's work, and work not yet committed is still the work. Review already ships a documented default (`openChanges: false` = committed changes only, with a recorded rationale about prompt non-convergence, Issue #2); silently widening it would change an existing contract.

5. **Snapshot failure degrades, never fails.** Any throw or non-zero exit produces `null`, one debug line, and the pre-existing branch-based range. A diagnostic aid must not become a new way for a stage to fail.

6. **Cleanup is best-effort in `finally`.** A leaked `refs/karst/snapshot/*` ref is inert (unreferenced by any branch, invisible to `git branch`, not pushed). Deletion failure is swallowed after a debug line.

---

## Execution Order

### Task 1: Create the snapshot module and its tests

#### Objective

Add `createReviewSnapshot` and `deleteReviewSnapshot`: build a commit from the live worktree inside the existing quarantine machinery, point a `refs/karst/snapshot/...` ref at it, and delete that ref later. No branch, HEAD, or index mutation.

#### Files

- `src/workflow/reviewSnapshot.ts` — **created.** The whole feature's git mechanics.
- `src/workflow/reviewSnapshot.test.ts` — **created.** Colocated tests against a real temp repo.

#### Implementation

Create `src/workflow/reviewSnapshot.ts` with exactly these contents' structure:

1. Imports (ESM, `.js` suffixes):
   ```ts
   import { createHash } from 'node:crypto';
   import {
     prepareCommitInQuarantine,
     promoteQuarantinedObjects,
     cleanupQuarantine,
     type GitRunner,
     type PersistedCommitIdentity,
   } from '../integrations/git.js';
   import { canonicalPath } from '../runtime/pathScope.js';
   ```

2. Export `const SNAPSHOT_REF_PREFIX = 'refs/karst/snapshot';`

3. Export `function snapshotRepoKey(repoPath: string): string` — returns
   `createHash('sha256').update(canonicalPath(repoPath)).digest('hex').slice(0, 16)`.

4. Export `function snapshotRefName(ticketId: number, repoPath: string): string` — returns
   `` `${SNAPSHOT_REF_PREFIX}/${ticketId}/${snapshotRepoKey(repoPath)}` ``.

5. Export interface:
   ```ts
   export interface CreateReviewSnapshotOpts {
     /** The ticket the snapshot belongs to — part of the ref name. */
     ticketId: number;
     /** The repository path the worktree row carries; hashed into the ref name. */
     repoPath: string;
     /** The worktree root. Every git command runs here. */
     worktreePath: string;
     /** Verbose decision-point logging, prefixed `[gate]`. */
     debug?: (message: string) => void;
     /** Injected clock for the commit identity timestamp. */
     now?: () => string;
   }
   ```

6. Export `async function createReviewSnapshot(git: GitRunner, opts: CreateReviewSnapshotOpts): Promise<string | null>`.

   Returns the **ref name** on success, `null` on any failure. Never throws. Body:

   a. `const ref = snapshotRefName(opts.ticketId, opts.repoPath);`
      `const key = \`snapshot-${opts.ticketId}-${snapshotRepoKey(opts.repoPath)}\`;`
      (`key` satisfies `/^[A-Za-z0-9._-]+$/`.)

   b. Wrap everything from here in `try { … } catch (error) { debug + return null; }`.

   c. Resolve the parent: `const head = await git(['rev-parse', 'HEAD'], opts.worktreePath);`
      If `head.exitCode !== 0` or `head.stdout.trim() === ''`, emit
      `` opts.debug?.(`[gate] snapshot ${ref}: no resolvable HEAD — falling back to the branch range`) ``
      and `return null`.

   d. Resolve identity with the same precedence ship uses (do **not** import ship's private helper; inline it here):
      ```ts
      const nameR = await git(['config', 'user.name'], opts.worktreePath);
      const emailR = await git(['config', 'user.email'], opts.worktreePath);
      const at = (opts.now ?? (() => new Date().toISOString()))();
      const identity: PersistedCommitIdentity = {
        name: nameR.exitCode === 0 && nameR.stdout.trim() ? nameR.stdout.trim() : 'karst',
        email: emailR.exitCode === 0 && emailR.stdout.trim() ? emailR.stdout.trim() : 'karst@local',
        at,
      };
      ```

   e. Prepare, promote, point the ref:
      ```ts
      const prepared = await prepareCommitInQuarantine(git, opts.worktreePath, key, {
        preHead: head.stdout.trim(),
        message: `karst review snapshot for ticket ${opts.ticketId}`,
        author: identity,
        committer: identity,
      });
      await promoteQuarantinedObjects(git, opts.worktreePath, key);
      const update = await git(['update-ref', ref, prepared.expectedHead], opts.worktreePath);
      if (update.exitCode !== 0) {
        opts.debug?.(`[gate] snapshot ${ref}: update-ref failed — falling back to the branch range`);
        return null;
      }
      opts.debug?.(`[gate] snapshot ${ref}: created at ${prepared.expectedHead.slice(0, 7)}`);
      return ref;
      ```

   f. `finally` (inside the function, around the prepare/promote/update block): `await cleanupQuarantine(git, opts.worktreePath, key).catch(() => {});`
      The quarantine directory is temporary scaffolding; the promoted objects and the ref are what survive.

   g. The `catch` emits
      `` opts.debug?.(`[gate] snapshot ${ref}: failed (${error instanceof Error ? error.message : String(error)}) — falling back to the branch range`) ``
      and returns `null`.

7. Export `async function deleteReviewSnapshot(git: GitRunner, opts: { ticketId: number; repoPath: string; worktreePath: string; debug?: (m: string) => void }): Promise<void>`:
   ```ts
   const ref = snapshotRefName(opts.ticketId, opts.repoPath);
   try {
     const r = await git(['update-ref', '-d', ref], opts.worktreePath);
     if (r.exitCode !== 0) opts.debug?.(`[gate] snapshot ${ref}: delete failed (exit ${r.exitCode})`);
     else opts.debug?.(`[gate] snapshot ${ref}: deleted`);
   } catch (error) {
     opts.debug?.(`[gate] snapshot ${ref}: delete threw (${error instanceof Error ? error.message : String(error)})`);
   }
   ```
   Never throws.

Add a module-level doc comment stating: this builds a throwaway commit from the live worktree so a gate lane can read committed **and** uncommitted work as one range; it never calls `compareAndSwapHeadAndIndex`, so the branch, HEAD and index are never written; the ref is local and never pushed.

Create `src/workflow/reviewSnapshot.test.ts` using the real-repo helpers already used by `src/integrations/git.test.ts` (read that file first and mirror its temp-repo setup and its `defaultGitRunner` usage). Required cases:

1. **captures uncommitted tracked, staged and untracked files in the snapshot tree** — init a repo, commit one file, then modify a tracked file, stage a second new file, and leave a third untracked. Call `createReviewSnapshot`. Assert `git diff --name-only <HEAD-before>...<returnedRef>` lists all three paths.
2. **leaves HEAD, the branch and the index untouched** — capture `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD` and `git status --porcelain` before and after; assert all three are byte-identical after the call.
3. **the snapshot ref is reachable and its parent is the pre-call HEAD** — assert `git rev-parse <ref>^` equals the pre-call HEAD sha.
4. **honors .gitignore** — add `ignored.txt` plus a `.gitignore` containing `ignored.txt`; assert the snapshot diff does not list `ignored.txt`.
5. **a clean worktree still produces a ref whose tree equals HEAD's tree** — assert `git rev-parse <ref>^{tree}` equals `git rev-parse HEAD^{tree}`.
6. **returns null and never throws when HEAD is unborn** — init a repo with no commits; assert the return value is `null` and no exception escapes.
7. **returns null when update-ref fails** — pass a fake `GitRunner` that forwards to the real runner except for `update-ref`, which returns `{ exitCode: 1, stdout: '', stderr: 'boom' }`; assert `null`.
8. **`deleteReviewSnapshot` removes the ref and is safe to call twice** — assert `git rev-parse --verify <ref>` fails after the first delete, and the second call does not throw.
9. **`snapshotRefName` is stable and ref-safe** — assert the name matches `/^refs\/karst\/snapshot\/\d+\/[0-9a-f]{16}$/` and that two different repo paths yield different names.

#### Constraints

- Do **not** modify `src/integrations/git.ts`.
- Do **not** call `compareAndSwapHeadAndIndex` — importing it in this module is a defect.
- Do **not** add a dependency. `node:crypto` and the existing imports are sufficient.
- The module must remain `vscode`-free and take `GitRunner` by injection (project invariant: host-agnostic logic takes injected interfaces).
- Neither exported function may throw. Every failure path returns `null` / resolves.
- Do not push, fetch, or contact a remote anywhere in this module.

#### Edge Cases

- **Unborn HEAD** (repo with zero commits): `rev-parse HEAD` fails → return `null`.
- **Clean worktree**: succeed normally; the snapshot commit's tree equals HEAD's tree. This is correct, not an error.
- **`git config user.name` / `user.email` unset**: fall back to `karst` / `karst@local`, exactly as ship does.
- **Linked worktree** (every worktree karst cuts): handled by `prepareCommitInQuarantine`'s existing `mainObjectsPath` common-dir logic. Do not add worktree-specific handling.
- **Ref already exists from a previous run**: `git update-ref <ref> <sha>` overwrites unconditionally. Do not pre-delete.
- **`.gitignore`d files**: excluded, because `add -A` honors ignore rules. This is intended.
- **Quarantine cleanup failure**: swallowed via `.catch(() => {})`; it must not mask a successful snapshot.

#### Verification

```bash
npx vitest run src/workflow/reviewSnapshot.test.ts
npm run typecheck
```

Expected:
- All 9 test cases in `reviewSnapshot.test.ts` pass.
- `tsc --noEmit` exits 0 with no output.

#### Completion Criteria

- [ ] `src/workflow/reviewSnapshot.ts` exists and exports `SNAPSHOT_REF_PREFIX`, `snapshotRepoKey`, `snapshotRefName`, `CreateReviewSnapshotOpts`, `createReviewSnapshot`, `deleteReviewSnapshot`.
- [ ] `compareAndSwapHeadAndIndex` appears nowhere in the file.
- [ ] All 9 listed test cases exist and pass.
- [ ] `npm run typecheck` exits 0.

---

### Task 2: Teach `buildScopeBlock` to point at a snapshot ref

#### Objective

Give the shared scope block a `snapshotRef` option. When present, the emitted diff range targets the snapshot ref and the prompt states the range already includes uncommitted work. When absent, output is byte-identical to today.

#### Files

- `src/workflow/agentScope.ts` — **modified.** Add the option; branch `diffLine` and the empty-diff guard on it.
- `src/workflow/agentScope.test.ts` — **modified.** Add cases for the new branch; keep existing cases green.

#### Implementation

Depends on Task 1 only conceptually (no import). Changes to `src/workflow/agentScope.ts`:

1. Add to `ScopeBlockOpts`:
   ```ts
   /**
    * A disposable snapshot ref (`refs/karst/snapshot/...`) whose commit carries
    * the worktree's committed AND uncommitted content as one tree
    * (`workflow/reviewSnapshot.ts`). When present it REPLACES the branch as the
    * diff head, so the range is complete no matter what the agent left
    * uncommitted, and `openChanges` no longer changes the range. Absent → the
    * branch-based range, exactly as before.
    */
   snapshotRef?: string | null;
   ```

2. Change `diffLine`'s signature to
   `function diffLine(subject: string, baseRef?: string | null, branch?: string | null, openChanges?: boolean, snapshotRef?: string | null): string`.

   At the top of its body, add the snapshot branch and return early:
   ```ts
   const snapshot = snapshotRef?.trim() || null;
   if (snapshot !== null) {
     const range = baseRef
       ? `\`git diff origin/${baseRef}...${snapshot}\` (or \`git diff ${baseRef}...${snapshot}\` when the remote ref is absent)`
       : `\`git diff <base-branch>...${snapshot}\``;
     return (
       `- The changes to ${subject} are exactly: ${range}. That ref is a snapshot of this worktree ` +
       `taken by the orchestrator: it ALREADY includes uncommitted and untracked work, so do NOT ` +
       `run \`git status\` to look for more, and do NOT treat missing commits on the branch as missing work.`
     );
   }
   ```
   Leave the existing committed-only / `openChanges` wording below it untouched for the `snapshot === null` path.

3. In `buildScopeBlock`, add `const snapshotRef = opts.snapshotRef?.trim() || null;` and pass it as the fifth argument to `diffLine`.

4. Replace the `emptyDiffGuard` expression so the snapshot case gets its own wording. Current behavior: the guard is emitted only when `branch !== null`, and tells the agent an empty diff is a resolution failure to investigate. Required behavior: when `snapshotRef !== null`, the range is authoritative, so an empty diff genuinely means no changes — but the agent must still report that rather than silently emit `[]`.
   ```ts
   const emptyDiffGuard =
     snapshotRef !== null
       ? `- That range is authoritative: it resolves without a remote and already contains uncommitted work. If it comes back EMPTY, this worktree genuinely matches the base — report exactly one observation (severity "info", title "no changes to ${subject}") rather than silently outputting \`[]\`.`
       : branch !== null
         ? /* existing string, unchanged */
         : null;
   ```
   Keep the existing `branch !== null` guard string exactly as it is today — copy it verbatim into the new nested ternary.

5. Leave `orientation` untouched. The wrong-checkout hard stop still applies: a snapshot is only ever created for a target that already passed the checkout guard (Task 3), so the two never contradict.

6. Extend the module doc comment with one paragraph: when the host supplies a `snapshotRef`, the range is snapshot-based, which removes the empty-diff failure mode that arises when an agent leaves work uncommitted until ship.

Add to `src/workflow/agentScope.test.ts`:

1. **snapshotRef replaces the branch as the diff head** — assert the emitted block contains `git diff origin/develop...refs/karst/snapshot/7/abc123abc123abcd` and does **not** contain `origin/feature-branch` in the diff line.
2. **snapshotRef states uncommitted work is already included** — assert the block contains `ALREADY includes uncommitted and untracked work`.
3. **snapshotRef suppresses the committed-only wording** — assert the block does **not** contain `committed changes only`.
4. **snapshotRef wins over `openChanges: false`** — pass both; assert the range is still snapshot-based and `committed changes only` is absent.
5. **snapshotRef swaps the empty-diff guard** — assert the block contains `That range is authoritative` and does not contain `An empty \`git diff\` is NOT proof of no changes`.
6. **absent snapshotRef is byte-identical to today** — build the block twice, once with `snapshotRef: undefined` and once with the option omitted entirely, and assert both equal a snapshot of the existing expected output (reuse whatever assertion style the file already uses for the current cases).
7. **blank snapshotRef is treated as absent** — pass `snapshotRef: '   '`; assert the branch-based range is emitted.

#### Constraints

- Preserve the public signature `buildScopeBlock(intent, opts)`; `snapshotRef` is additive and optional.
- Do not change the `orientation` line or the wrong-checkout hard stop.
- Do not change the `gateLine` or the `Scope rules (strict):` list.
- Do not remove or repurpose `openChanges`; it keeps its current meaning on the non-snapshot path.
- Every existing test in `agentScope.test.ts` must still pass unmodified.

#### Edge Cases

- `snapshotRef: undefined` / omitted / `null` / whitespace-only → branch-based range, unchanged output.
- `snapshotRef` present **and** `baseRef` null → `` `git diff <base-branch>...<snapshotRef>` ``.
- `snapshotRef` present and `branch` null → snapshot range still wins; no `origin/HEAD` is ever emitted.
- `snapshotRef` present and `openChanges: true` → snapshot range; the `plus any uncommitted work` clause is **not** appended (the snapshot already has it).

#### Verification

```bash
npx vitest run src/workflow/agentScope.test.ts
npm run typecheck
```

Expected:
- All 7 new cases pass; every pre-existing case in the file passes unchanged.
- `tsc --noEmit` exits 0.

#### Completion Criteria

- [ ] `ScopeBlockOpts.snapshotRef` exists and is documented.
- [ ] `diffLine` returns the snapshot range when `snapshotRef` is non-blank.
- [ ] The empty-diff guard has a distinct snapshot wording.
- [ ] All 7 new cases pass and no pre-existing case was edited.
- [ ] `npm run typecheck` exits 0.

---

### Task 3: Wire the UAT Tester to snapshot every verified target

#### Objective

Before each UAT Tester call — and only after the wrong-checkout guard passes — create a snapshot ref for that target and thread it into the prompt. Delete it when the run finishes.

#### Files

- `src/workflow/uat/tester.ts` — **modified.** Snapshot creation, prompt threading, cleanup.
- `src/workflow/uat/tester.test.ts` — **modified.** New cases for snapshot behavior.

#### Implementation

Depends on Tasks 1 and 2.

1. Import at the top of `tester.ts`:
   ```ts
   import { createReviewSnapshot, deleteReviewSnapshot } from '../reviewSnapshot.js';
   ```

2. Add a fifth parameter to `buildTesterPrompt`:
   ```ts
   export function buildTesterPrompt(
     target: TesterTarget,
     instructions?: string,
     gatesPassed?: readonly string[],
     snapshotRef?: string | null,
   ): string
   ```
   and pass it through at line 297:
   ```ts
   ...buildScopeBlock('test', { baseRef: target.baseRef, branch: target.branch, gatesPassed, snapshotRef }),
   ```
   The parameter is optional, so every existing caller and test keeps compiling.

3. In the per-target loop in `runUatTester`, **after** the existing `checkoutBranch` verification decides the target is not a wrong checkout and before the prompt is built:
   ```ts
   const snapshotRef = opts.git
     ? await createReviewSnapshot(opts.git, {
         ticketId: opts.ticketId,
         repoPath: target.repo,
         worktreePath: target.worktreePath,
         debug: opts.debug,
       })
     : null;
   ```
   Pass `snapshotRef` into the `buildTesterPrompt(...)` call for that target.

   Rationale to preserve: `opts.git` is already the injected runner used for checkout verification and is documented as optional (absent → verification is skipped). When it is absent there is no runner to snapshot with, so the lane behaves exactly as it does today.

4. Track created refs for cleanup. Declare `const snapshotted: { repo: string; worktreePath: string }[] = [];` before the loop; push `{ repo: target.repo, worktreePath: target.worktreePath }` whenever `snapshotRef !== null`. After the loop completes — in a `finally` that also covers the abort/interrupt paths — run:
   ```ts
   if (opts.git) {
     for (const s of snapshotted) {
       await deleteReviewSnapshot(opts.git, {
         ticketId: opts.ticketId,
         repoPath: s.repo,
         worktreePath: s.worktreePath,
         debug: opts.debug,
       });
     }
   }
   ```
   Place the `finally` so it runs on the normal return, on an abort, and on a throw. Do not let a cleanup failure change the run's result — `deleteReviewSnapshot` already swallows its own errors.

5. Emit one debug line per target after the snapshot attempt:
   `` opts.debug?.(`[gate] uat tester ${target.repo}: snapshot ${snapshotRef ?? 'unavailable — using the branch range'}`) ``

Add to `src/workflow/uat/tester.test.ts` (mirror the file's existing fake-adapter and fake-`GitRunner` style):

1. **the prompt carries the snapshot range when a snapshot succeeds** — fake git returns success for `rev-parse HEAD`, `config`, `update-ref`; stub `createReviewSnapshot`'s git calls so a ref is produced. Assert the prompt handed to the adapter contains `refs/karst/snapshot/` and not `committed changes only`.
2. **a snapshot failure falls back to the branch range and still runs the target** — fake git fails `update-ref`. Assert the adapter was still called exactly once for the target and the prompt contains the `origin/<base>...origin/<branch>` range.
3. **no snapshot is attempted for a wrong checkout, and the target is still skipped** — fake `rev-parse --abbrev-ref HEAD` answers a different branch. Assert no `update-ref` call was made, the adapter was not called for that target, and the deterministic `critical` `wrong checkout` observation is still recorded.
4. **the snapshot ref is deleted after the run** — assert a `['update-ref', '-d', <ref>]` invocation reached the fake git runner after the adapter call.
5. **the ref is deleted even when the adapter throws** — make the adapter reject; assert the delete still ran and the original error still surfaces as the lane's existing failure outcome.
6. **`opts.git` absent → no snapshot calls and today's prompt** — omit `git`; assert the prompt contains the branch range and no `refs/karst/snapshot/` string.

#### Constraints

- Do **not** move, weaken, or reorder the `checkoutBranch` wrong-checkout guard. The snapshot must come after it.
- Do **not** make `opts.git` required.
- Do **not** change `TesterTarget`, `RunUatTesterOpts` (beyond nothing — no new field is needed), the observation parsing, the cap logic, or `countBlockingObservations`.
- Do **not** persist the snapshot sha to the store.
- A snapshot or cleanup failure must not change the run's outcome kind.

#### Edge Cases

- **`opts.git` absent** → `snapshotRef` is `null`; prompt and behavior identical to today.
- **Snapshot fails for one target of several** → only that target falls back; the others keep their snapshot ranges.
- **Run aborted mid-loop (`opts.signal`)** → the `finally` still deletes every ref created so far.
- **Adapter throws** → cleanup still runs; the original error is still reported.
- **Two targets sharing one `repo` path** — cannot occur: `dedupeTargetsByRepoPath` collapses them upstream. Do not add de-duplication here.

#### Verification

```bash
npx vitest run src/workflow/uat/tester.test.ts
npx vitest run src/workflow/stages/uat.test.ts
npm run typecheck
```

Expected:
- All 6 new cases pass; every pre-existing case in both files passes unchanged.
- `tsc --noEmit` exits 0.

#### Completion Criteria

- [ ] `buildTesterPrompt` accepts and forwards `snapshotRef`.
- [ ] Snapshot creation is positioned strictly after the checkout guard.
- [ ] Cleanup runs in a `finally` covering normal, abort and throw paths.
- [ ] All 6 new cases pass; `uat.test.ts` still passes unchanged.
- [ ] `npm run typecheck` exits 0.

---

### Task 4: Wire the Review findings lane behind `openChanges`

#### Objective

When `review.openChanges` is `true`, give the review lane the same snapshot range instead of the prose "also run `git status`" hint. When it is `false`, review is untouched.

#### Files

- `src/workflow/review/findingsLane.ts` — **modified.** Conditional snapshot creation, prompt threading, cleanup.
- `src/workflow/review/findingsLane.test.ts` — **modified.** New cases for both branches of the flag.

#### Implementation

Depends on Tasks 1 and 2.

1. Import `createReviewSnapshot` and `deleteReviewSnapshot` from `'../reviewSnapshot.js'`.

2. Read `findingsLane.ts` and locate the per-target loop that calls the prompt builder feeding `buildScopeBlock('review', { baseRef, branch, openChanges })` (line 192 today). Immediately before that call, add:
   ```ts
   const snapshotRef =
     openChanges && git
       ? await createReviewSnapshot(git, {
           ticketId,
           repoPath: <the target's repo path in this scope>,
           worktreePath: <the target's worktree path in this scope>,
           debug,
         })
       : null;
   ```
   Use whatever the surrounding identifiers for the git runner, ticket id, repo path, worktree path and debug callback already are in that scope — do not rename them, and do not add new parameters to the lane's public options if the values are already reachable. If the lane has no git runner in scope, thread the same optional `git?: GitRunner` option the Tester already uses (`RunUatTesterOpts.git`, `tester.ts:97`), defaulting to `undefined`, and pass `null` when it is absent.

3. Pass `snapshotRef` into `buildScopeBlock('review', { baseRef, branch, openChanges, snapshotRef })`.

4. Mirror Task 3's cleanup: collect the targets that produced a ref and delete them in a `finally` that covers the normal, abort and throw paths.

5. Emit one debug line per target:
   `` debug?.(`[gate] review lane ${repo}: snapshot ${snapshotRef ?? (openChanges ? 'unavailable — using the branch range' : 'not requested (openChanges off)')}`) ``

Add to `src/workflow/review/findingsLane.test.ts`:

1. **`openChanges: false` creates no snapshot and emits today's committed-only prompt** — assert no `update-ref` reached the fake git runner and the prompt contains `committed changes only`.
2. **`openChanges: true` creates a snapshot and emits the snapshot range** — assert the prompt contains `refs/karst/snapshot/` and does not contain `plus any uncommitted work`.
3. **`openChanges: true` with a failing snapshot falls back to the branch range and still reviews** — assert the lane still called the adapter once and the prompt contains the `origin/<base>...origin/<branch>` range.
4. **the ref is deleted after the lane finishes** — assert an `['update-ref', '-d', <ref>]` call reached the fake runner.

#### Constraints

- Do **not** change the default of `review.openChanges`, its type in `src/manifest/types.ts`, its schema validator, or its settings UI.
- Do **not** make review snapshot unconditionally — the `openChanges === false` path must be byte-identical to today's prompt.
- Do **not** change findings parsing, severity handling, or the `maxFindings` cap.
- Do **not** persist the snapshot sha.

#### Edge Cases

- **`openChanges: false`** → no snapshot, no `update-ref`, no cleanup, prompt unchanged.
- **`openChanges: true`, git runner absent** → `snapshotRef` is `null`; the existing `plus any uncommitted work` prose path applies, exactly as today.
- **`openChanges: true`, snapshot fails** → branch range plus today's `plus any uncommitted work` prose; the lane still runs.
- **Lane aborted or throws** → cleanup still runs for every ref created.

#### Verification

```bash
npx vitest run src/workflow/review/findingsLane.test.ts
npx vitest run src/workflow/stages/review.test.ts
npm run typecheck
```

Expected:
- All 4 new cases pass; every pre-existing case in both files passes unchanged.
- `tsc --noEmit` exits 0.

#### Completion Criteria

- [ ] Snapshot creation in the review lane is gated on `openChanges === true`.
- [ ] The `openChanges: false` prompt is unchanged from today.
- [ ] Cleanup runs in a `finally`.
- [ ] All 4 new cases pass; `review.test.ts` still passes unchanged.
- [ ] `npm run typecheck` exits 0.

---

### Task 5: Document the snapshot ref in the stages/gates reference

#### Objective

Record the invariant so a future change does not reintroduce branch mutation at a gate stage.

#### Files

- `docs/arch/stages-and-gates.md` — **modified.** One new section.

#### Implementation

Read `docs/arch/stages-and-gates.md` and locate the section that describes the gate lanes (the UAT Tester / Review findings lanes). Insert a new `##` section immediately after it, titled:

`## Gate lanes read a snapshot ref, never the branch alone`

The section must state, in the document's existing prose voice:

1. Agents are allowed to leave implementation work uncommitted until ship — this is already the rule `gates/targets.ts` selects on, and the gate lanes must honor the same rule when they *read* the work, not only when they decide a repo is affected.
2. Before a lane's agent call, `workflow/reviewSnapshot.ts` builds a commit from the live worktree using the ship quarantine machinery (`prepareCommitInQuarantine` + `promoteQuarantinedObjects`) and points `refs/karst/snapshot/<ticketId>/<repoKey>` at it. The agent's diff range is `origin/<base>...<that ref>`.
3. `compareAndSwapHeadAndIndex` is deliberately **not** called: that is the only function that installs a prepared commit onto HEAD/index, so the ticket branch, HEAD, the index and the remote are never written by a gate. A gate observes; it does not reach back.
4. UAT snapshots unconditionally. Review snapshots only under `review.openChanges`, so its shipped committed-only default is unchanged.
5. Snapshot failure is never fatal: the lane falls back to the branch range and proceeds. The ref is deleted when the lane finishes; a leaked ref is inert and unreachable from any branch.

Do not restructure or re-order the rest of the file.

#### Constraints

- Documentation only. Change no code in this task.
- Do not edit any other file under `docs/arch/`.
- Do not delete or rewrite existing sections.

#### Edge Cases

- None. This task is additive prose.

#### Verification

```bash
grep -n "Gate lanes read a snapshot ref" docs/arch/stages-and-gates.md
```

Expected:
- Exactly one match, and the five points above are present in the new section.

#### Completion Criteria

- [ ] The new section exists in `docs/arch/stages-and-gates.md`.
- [ ] All five required points are stated.
- [ ] No pre-existing section was modified or removed.

---

## Final Verification

1. Run the full unit suite and confirm no regression against the pre-change baseline of **443 files / 8183 tests passing**. The new cases raise both counts; nothing may move from passing to failing.
2. Confirm the build emits and the build verifier passes.
3. Confirm, by grep, that no gate-lane code path can land a commit on a branch.

Commands:

```bash
npm run typecheck
npm run test:unit
npm run build
grep -rn "compareAndSwapHeadAndIndex" src/workflow/ || echo "OK: no CAS in workflow gate paths"
```

Expected:
- `npm run typecheck` exits 0 with no output.
- `npm run test:unit` reports 0 failed; total files ≥ 444 and total tests ≥ 8209 (baseline 443 / 8183 plus the 26 cases this plan adds: 9 + 7 + 6 + 4).
- `npm run build` ends with `verify-build: ok (dist/extension.js, dist/cli/main.js, guide smoke test)`.
- The final `grep` prints `OK: no CAS in workflow gate paths`. Any match under `src/workflow/` is a defect introduced by this plan and must be removed before the plan is complete.

Manual verification (performed once, in a scratch clone — not in this repository):

1. Create a temp git repo, commit one file, then edit a tracked file and add an untracked one without committing.
2. In a Node REPL, import `createReviewSnapshot` from the built output and call it against that repo.
3. Confirm `git log --oneline` shows no new commit on the branch, `git status --porcelain` is unchanged, and `git diff <base>...refs/karst/snapshot/1/<key>` lists both the edited and the untracked file.
4. Call `deleteReviewSnapshot`; confirm `git rev-parse --verify refs/karst/snapshot/1/<key>` fails.

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach. In particular: do not replace the snapshot ref with `git commit`, `git stash`, or a worktree copy.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them: ESM imports carry `.js` suffixes; `noUncheckedIndexedAccess` is on, so indexed access needs a guard or `!`; host-agnostic modules take injected interfaces and never import `vscode`; tests are colocated.
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.

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
