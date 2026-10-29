# Sandbox → host sync via a private ref Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sandbox → host sync from reading the shared per-worktree `FETCH_HEAD`, so a concurrent or failed `git fetch` can no longer make an in-sync sandbox read as "not a fast-forward".

**Architecture:** The sandbox bundle is fetched into a private ref `refs/karst/sandbox/<branch>` (`--no-write-fetch-head`, forced refspec). The ref is resolved ONCE to a sha; classify, `merge --ff-only`, `diff` and every host-side consumer use that sha (or the private ref), never `FETCH_HEAD`. An unresolvable ref is an error result, never `diverged`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `noUncheckedIndexedAccess`), vitest, git.

**Spec:** ticket FIX-SANDBOX-SANDBOX-HOST-SYNC (decisions D299); `docs/arch/agent-cores.md` `[@arch:AC-39]` (sync paragraph, item 5) and `[@arch:AC-38]`.

## Global Constraints

- ESM: imports need the `.js` suffix. `noUncheckedIndexedAccess` is on.
- Host git for the sbx path keeps `HARDENED_GIT` flags and `HARDENED_ENV` (arch:AC-31/AC-34). Only the fetch args change.
- No `spawnSync`. Files stay < 400 lines typical.
- Out of scope: in-sandbox `REFRESH_SCRIPT` (`src/agent/cloneRefresh.ts`) keeps its own `FETCH_HEAD`; sandbox gate failures from a missing `node_modules` (separate ticket).
- Test commands: `npx vitest run <file>` (single file), `npm run -s typecheck`. Full suite once at the end. Mutation gate (`src/extension/**` changes ≥ 85): `npx stryker run --mutate <changed files>` then `node scripts/mutationSummary.mjs`.
- Commits: conventional (`fix: …`). End each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File Structure

- Modify `src/agent/cloneSyncClass.ts` — owns the private-ref name, the fetch args, `resolveSandboxHead`, and a sha-taking `classifyCloneRelation`. (Both runners already import it.)
- Modify `src/agent/docker/dockerClone.ts`, `src/agent/sbx/sbxRunner.ts` — fetch into the private ref, resolve once, use the sha.
- Modify `src/extension/ops/sandboxRewrite.ts`, `src/extension/ops/sandboxCarryOp.ts` — read the private ref instead of `FETCH_HEAD`.
- Modify comments only: `src/extension/ops/sandboxSyncOps.ts` (lines ~316, ~351), `src/extension/ops/deliverToPrOps.ts` (~42-45), `src/agent/sessionRunner.ts` (~125).
- Modify `docs/arch/agent-cores.md` `[@arch:AC-39]` item (5).

## Test-rig note (read first)

The fakes (`fakeSbxProcess`, `fakeDockerProcess`) answer `stdout: ''` unless a key matches. `rev-parse --verify <ref>^{commit}` now runs in every sync, so each rig that expects a successful sync must answer it with a sha, e.g. `const SANDBOX_SHA = 'a'.repeat(40)` and key `` `${G} rev-parse --verify --quiet refs/karst/sandbox/feat/x^{commit}` `` (sbx, `G` is the existing hardened-git prefix) / `'git -C /w t rev-parse --verify --quiet refs/karst/sandbox/feat/x^{commit}'` (docker). Keys match by `startsWith`, longest wins.

---

### Task 1: Shared private-ref helpers and sha-taking classifier

**Files:**
- Modify: `src/agent/cloneSyncClass.ts`
- Test: `src/agent/cloneSyncClass.test.ts` (create if absent: `ls src/agent/cloneSyncClass.test.ts`)

**Interfaces:**
- Produces:
  - `sandboxHeadRef(branch: string): string` → `` `refs/karst/sandbox/${branch}` ``
  - `fetchSandboxBundleArgs(bundlePath: string, branch: string): string[]` → `['fetch','--no-write-fetch-head', bundlePath, '+refs/heads/<b>:refs/karst/sandbox/<b>']`
  - `resolveSandboxHead(git: (args: string[]) => Promise<{ code: number; stdout: string }>, branch: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }>`; failure reason is exactly `cannot read the sandbox head`
  - `classifyCloneRelation(sandboxSha: string, isAncestor: (older: string, newer: string) => Promise<boolean>): Promise<CloneRelation>` (signature change: sha is the new FIRST arg)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { classifyCloneRelation, fetchSandboxBundleArgs, resolveSandboxHead, sandboxHeadRef } from './cloneSyncClass.js';

const SHA = 'a'.repeat(40);

describe('private sandbox ref', () => {
  it('names the ref and builds the fetch args without touching FETCH_HEAD', () => {
    expect(sandboxHeadRef('feat/x')).toBe('refs/karst/sandbox/feat/x');
    expect(fetchSandboxBundleArgs('/b/out.bundle', 'feat/x')).toEqual([
      'fetch', '--no-write-fetch-head', '/b/out.bundle', '+refs/heads/feat/x:refs/karst/sandbox/feat/x',
    ]);
  });

  it('resolves the ref to a sha once', async () => {
    const seen: string[][] = [];
    const out = await resolveSandboxHead(async (args) => { seen.push(args); return { code: 0, stdout: `${SHA}\n` }; }, 'feat/x');
    expect(out).toEqual({ ok: true, sha: SHA });
    expect(seen).toEqual([['rev-parse', '--verify', '--quiet', 'refs/karst/sandbox/feat/x^{commit}']]);
  });

  it.each([{ code: 1, stdout: '' }, { code: 0, stdout: '' }, { code: 0, stdout: 'not-a-sha' }])('unreadable head %j is an error, never diverged', async (res) => {
    expect(await resolveSandboxHead(async () => res, 'feat/x')).toEqual({ ok: false, reason: 'cannot read the sandbox head' });
  });
});

describe('classifyCloneRelation', () => {
  const rel = (ancestors: Array<[string, string]>) =>
    classifyCloneRelation(SHA, async (o, n) => ancestors.some(([a, b]) => a === o && b === n));
  it('ahead when HEAD is an ancestor of the sandbox sha', async () => { expect(await rel([['HEAD', SHA]])).toBe('ahead'); });
  it('behind when the sandbox sha is an ancestor of HEAD', async () => { expect(await rel([[SHA, 'HEAD']])).toBe('behind'); });
  it('diverged when neither', async () => { expect(await rel([])).toBe('diverged'); });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/agent/cloneSyncClass.test.ts`
Expected: FAIL (`sandboxHeadRef` etc. not exported).

- [ ] **Step 3: Implement** (replace the file body below the `BEHIND_SUMMARY` export)

```ts
/** How the clone's head (the resolved sandbox sha) relates to the host worktree's HEAD. */
export type CloneRelation = 'ahead' | 'behind' | 'diverged';

/** Reply of {@link BEHIND_SUMMARY}: the clone is behind the host, so there is nothing to bring. */
export const BEHIND_SUMMARY = 'host ahead, nothing to bring';

const SHA = /^[0-9a-f]{40,64}$/;

/** Private ref the sandbox bundle is fetched into. FETCH_HEAD is one file per worktree that every fetch truncates, so it is never read. */
export const sandboxHeadRef = (branch: string): string => `refs/karst/sandbox/${branch}`;

/** Host git args that fetch the sandbox bundle's branch into {@link sandboxHeadRef} and leave FETCH_HEAD alone. */
export const fetchSandboxBundleArgs = (bundlePath: string, branch: string): string[] =>
  ['fetch', '--no-write-fetch-head', bundlePath, `+refs/heads/${branch}:${sandboxHeadRef(branch)}`];

export type SandboxHead = { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string };

/** Resolve the private ref to a sha ONCE; every later step uses that sha. Unreadable is an error, never `diverged`. */
export async function resolveSandboxHead(git: (args: string[]) => Promise<{ code: number; stdout: string }>, branch: string): Promise<SandboxHead> {
  const out = await git(['rev-parse', '--verify', '--quiet', `${sandboxHeadRef(branch)}^{commit}`]);
  const sha = out.stdout.trim();
  return out.code === 0 && SHA.test(sha) ? { ok: true, sha } : { ok: false, reason: 'cannot read the sandbox head' };
}

/**
 * Classify before merging, one rule for the sbx and docker runners.
 * `ahead` (also equal): host HEAD is an ancestor of the sandbox sha → fast-forward.
 * `behind`: the sandbox sha is an ancestor of host HEAD → nothing to bring; the host → clone refresh catches up.
 * `diverged`: neither → refused, never forced.
 */
export async function classifyCloneRelation(sandboxSha: string, isAncestor: (older: string, newer: string) => Promise<boolean>): Promise<CloneRelation> {
  if (await isAncestor('HEAD', sandboxSha)) return 'ahead';
  if (await isAncestor(sandboxSha, 'HEAD')) return 'behind';
  return 'diverged';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/agent/cloneSyncClass.test.ts` → PASS. (Typecheck fails in runners until Tasks 2-3; expected.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/cloneSyncClass.ts src/agent/cloneSyncClass.test.ts
git commit -m "fix: sandbox sync helpers for a private ref, not FETCH_HEAD"
```

---

### Task 2: Docker runner uses the private ref

**Files:**
- Modify: `src/agent/docker/dockerClone.ts` (imports; `fetchCloneBundle` ~122-134, `syncThroughBundle` ~136-149, `fetchFromClone` doc ~151, `diffFromClone` ~158-173)
- Test: `src/agent/docker/dockerClone.test.ts` (lines ~108-145), `src/agent/docker/dockerRunner.test.ts` (lines ~49-56)

**Interfaces:**
- Consumes: `fetchSandboxBundleArgs`, `resolveSandboxHead`, `classifyCloneRelation(sha, isAncestor)`, `sandboxHeadRef` from Task 1.
- Produces: `diffFromClone` returns `ref: <sha>` (not `'FETCH_HEAD'`).

- [ ] **Step 1: Update/add failing tests** in `dockerClone.test.ts` `describe('syncFromClone')`. Add `const SHA = 'a'.repeat(40); const HEAD_KEY = \`git -C /w t rev-parse --verify --quiet refs/karst/sandbox/feat/x^{commit}\`;` and give the rig `{ [HEAD_KEY]: { stdout: SHA } }`.
  - Happy path expected lines become:

```ts
expect(lines(proc)).toEqual([
  `docker run … git -c safe.directory=* -C /work/repo bundle create /bundle/out.bundle feat/x`, // unchanged
  'git -C /w t fetch --no-write-fetch-head /tmp/k1/out.bundle +refs/heads/feat/x:refs/karst/sandbox/feat/x',
  `git -C /w t rev-parse --verify --quiet refs/karst/sandbox/feat/x^{commit}`,
  `git -C /w t merge-base --is-ancestor HEAD ${SHA}`,
  `git -C /w t merge --ff-only ${SHA}`,
]);
```
  - Behind test keys: `` `git -C /w t merge-base --is-ancestor HEAD ${SHA}`: {code:1} `` and `` `git -C /w t merge-base --is-ancestor ${SHA} HEAD`: {code:0} ``.
  - Add the regression test (the T826 bug): a fake whose answer to the fetch also records a flag, and whose later calls behave as if FETCH_HEAD were empty. With the sha approach this is implicit, so assert there is NO call containing `FETCH_HEAD`:

```ts
it('never reads FETCH_HEAD: a fetch elsewhere in the worktree cannot break the sync', async () => {
  const proc = fakeDockerProcess({ [HEAD_KEY]: { stdout: SHA }, 'git -C /w t merge-base --is-ancestor HEAD FETCH_HEAD': { code: 1 }, 'git -C /w t merge --ff-only FETCH_HEAD': { code: 1, stderr: 'FETCH_HEAD empty' } });
  await expect(syncFromClone(ctx(proc), input)).resolves.toMatchObject({ ok: true });
  expect(lines(proc).some((l) => l.includes('FETCH_HEAD'))).toBe(false);
});

it('an unreadable sandbox head is an error, not a divergence, and never merges', async () => {
  const proc = fakeDockerProcess({ [HEAD_KEY]: { code: 1 } });
  await expect(syncFromClone(ctx(proc), input)).resolves.toEqual({ ok: false, reason: 'cannot read the sandbox head' });
  expect(lines(proc).some((l) => l.includes('merge'))).toBe(false);
});
```
  - `dockerRunner.test.ts` ~49-56: expect `merge --ff-only ${SHA}` and `diff HEAD...${SHA}` / `ref: SHA`, and give that rig the `HEAD_KEY` answer (path there is `/w/t7`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/agent/docker/dockerClone.test.ts src/agent/docker/dockerRunner.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`fetchCloneBundle` last two lines become:

```ts
const fetched = await ctx.proc.run('git', ['-C', input.hostWorktreePath, ...fetchSandboxBundleArgs(join(dir, 'out.bundle'), input.branch)]);
if (fetched.code !== 0) return { ok: false, reason: `git fetch of the sandbox bundle failed: ${detail(fetched)}` };
return { ok: true };
```
(doc comment: "…fetch it into the private `refs/karst/sandbox/<branch>` (FETCH_HEAD is never written)").

`syncThroughBundle`:

```ts
const fetched = await fetchCloneBundle(ctx, input, dir);
if (!fetched.ok) return fetched;
const head = await resolveSandboxHead(git, input.branch);
if (!head.ok) return head;
const relation = await classifyCloneRelation(head.sha, async (older, newer) => (await git(['merge-base', '--is-ancestor', older, newer])).code === 0);
…
const merged = await git(['merge', '--ff-only', head.sha]);
```

`diffFromClone`: after fetch, `const head = await resolveSandboxHead((a) => ctx.proc.run('git', ['-C', input.hostWorktreePath, ...a]), input.branch); if (!head.ok) return head;` then `git diff HEAD...${head.sha}`, return `ref: head.sha`. Update the `fetchFromClone` doc to "private ref". Import the new helpers from `../cloneSyncClass.js`.

- [ ] **Step 4: Run** — same command → PASS. Then `npx vitest run src/agent/docker` → PASS.

- [ ] **Step 5: Commit** — `git add src/agent/docker && git commit -m "fix: docker sandbox sync fetches into a private ref, not FETCH_HEAD"`

---

### Task 3: sbx runner uses the private ref

**Files:**
- Modify: `src/agent/sbx/sbxRunner.ts` (doc ~95; `fetchSandbox` fetch line ~114; `sync` ~180-195; `diff` ~219-228; imports)
- Test: `src/agent/sbx/sbxRunner.test.ts` (`describe('.sync')` ~95-143, `describe('.diff')` ~144-150)

**Interfaces:**
- Consumes: Task 1 helpers. `git(wt, args)` already exists in this file (returns `{code, stdout, stderr}`).
- Produces: `diff` returns `ref: <sha>`; `fetchClone` result shape unchanged (`{ok:true}` | `{ok:false,reason}`).

- [ ] **Step 1: Update/add failing tests.** `const SHA = 'a'.repeat(40);` and rig answer `` [`${G} rev-parse --verify --quiet refs/karst/sandbox/feat/x^{commit}`]: { stdout: SHA } `` in every sync/diff rig that expects success.
  - Happy path: `lines[1]` regex becomes `^${G} fetch --no-write-fetch-head \\S+/out\\.bundle \\+refs/heads/feat/x:refs/karst/sandbox/feat/x$`; `lines.slice(2)` becomes the `rev-parse --verify --quiet refs/karst/sandbox/feat/x^{commit}`, `merge-base --is-ancestor HEAD ${SHA}`, `merge --ff-only ${SHA}` lines. Note `calls[0]` is `rev-parse HEAD` (the `have` probe) — it keeps its exact text, so the new rev-parse key must not be a prefix of it (it isn't: it carries `--verify`).
  - Behind test: keys on `${SHA}` as in Task 2.
  - Failed-merge reason becomes `` `git merge --ff-only ${SHA} failed: dirty` ``.
  - Add the same two regression tests as Task 2 (`never reads FETCH_HEAD` asserting `proc.calls.every((c) => !c.args.includes('FETCH_HEAD'))`; unreadable head → `{ ok:false, reason:'cannot read the sandbox head' }` and no `merge` call), with `runner.sync!(ticket)`.
  - Diff test: key `` `${G} diff HEAD...${SHA}` `` and `ref: SHA`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/agent/sbx/sbxRunner.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `fetchSandbox`: `const fetched = await opts.proc.run('git', [...HARDENED_GIT, '-C', wt, ...fetchSandboxBundleArgs(path, branch)], { env: HARDENED_ENV });` and fix the doc comment ("…as the private `refs/karst/sandbox/<branch>`").

In `sync`, replace `const ref = 'FETCH_HEAD';` with:

```ts
const head = await resolveSandboxHead((args) => git(wt, args), ticket.branch);
if (!head.ok) return head;
const relation = await classifyCloneRelation(head.sha, async (older, newer) => (await git(wt, ['merge-base', '--is-ancestor', older, newer])).code === 0);
…
const merged = await git(wt, ['merge', '--ff-only', head.sha]);
if (merged.code !== 0) return { ok: false, reason: `git merge --ff-only ${head.sha} failed: ${merged.stderr.trim()}` };
```
In `diff`: same `resolveSandboxHead`, `git(wt, ['diff', \`HEAD...${head.sha}\`])`, return `ref: head.sha`. Import `fetchSandboxBundleArgs`, `resolveSandboxHead` next to the existing `classifyCloneRelation` import.

- [ ] **Step 4: Run** — `npx vitest run src/agent/sbx` → PASS; `npm run -s typecheck` → runner files clean (host consumers still compile; they only use strings).

- [ ] **Step 5: Commit** — `git add src/agent/sbx && git commit -m "fix: sbx sandbox sync fetches into a private ref, not FETCH_HEAD"`

---

### Task 4: Host-side consumers read the private ref

**Files:**
- Modify: `src/extension/ops/sandboxRewrite.ts:34-39`, `src/extension/ops/sandboxCarryOp.ts:53`; comments in `sandboxSyncOps.ts:316,351`, `deliverToPrOps.ts:42-45`, `sessionRunner.ts:125`
- Test: `src/extension/ops/sandboxRewrite.test.ts` (line 14), `src/extension/ops/sandboxSyncOps.test.ts` (339-341, 602), `src/extension/ops/sandboxLifecycleOps.test.ts` (332), `src/extension/ops/sandboxRewrite.integration.test.ts`, `src/extension/ops/deliverToPrOps.integration.test.ts`

**Interfaces:**
- Consumes: `sandboxHeadRef(branch)` from `../../agent/cloneSyncClass.js`.

- [ ] **Step 1: Update tests to fail.**
  - `sandboxRewrite.test.ts` line 14: `args[3] === 'FETCH_HEAD^{commit}'` → `args[3] === 'refs/karst/sandbox/<branch>^{commit}'` using the test's branch name (`sandboxHeadRef(BRANCH)`); line 42 test title → "diverged when the sandbox ref or HEAD cannot be resolved".
  - `sandboxSyncOps.test.ts` 339 → `rev-parse --verify --quiet refs/karst/sandbox/<branch>^{commit}`; 340-341, 602 are the old runner-side classifier keys: replace `FETCH_HEAD` with the sandbox sha the rig uses and add the `rev-parse` answer (these rigs fake a whole `SessionRunner`/process; if a key is no longer hit, delete it rather than keep a dead stub).
  - `sandboxLifecycleOps.test.ts` 332 → `merge --ff-only <sha>` (add the `rev-parse` answer to that rig).
  - `sandboxRewrite.integration.test.ts` and `deliverToPrOps.integration.test.ts` use real git: replace any `git fetch <bundle> <branch>` setup that leaves FETCH_HEAD with `fetch --no-write-fetch-head <bundle> +refs/heads/<b>:refs/karst/sandbox/<b>`. Add to the rewrite integration test: after the sandbox fetch, run an unrelated `git fetch` in the worktree (truncating FETCH_HEAD) and assert `classifyDivergence` still returns `rewritten`.
  - `deliverToPrOps.test.ts` uses `'FETCH_HEAD'` only as an opaque ref string returned by a fake `sandboxRef`; rename the literal to `SHA` for clarity, no behaviour change.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/extension/ops/sandboxRewrite.test.ts src/extension/ops/sandboxSyncOps.test.ts src/extension/ops/sandboxLifecycleOps.test.ts` → FAIL on the changed expectations.

- [ ] **Step 3: Implement.**

`sandboxRewrite.ts`: import `sandboxHeadRef`; line 39 → `const cloneHead = await revParse(run, input.worktree, sandboxHeadRef(input.branch));`; doc (line 34) → "once the clone's branch sits in the private `refs/karst/sandbox/<branch>` of the host worktree".

`sandboxCarryOp.ts` line 53 → `` await run(ref.hostWorktreePath, ['rev-parse', '--verify', '--quiet', `${sandboxHeadRef(ref.branch)}^{commit}`]) `` (import `sandboxHeadRef`). `verdict.cloneHead` compares by sha, unchanged.

Comments: `sandboxSyncOps.ts:316` → "The failed sync left the clone's branch in the private sandbox ref, which the classifier reads."; `:351` → "…Needs the clone's branch in the private sandbox ref of the host worktree."; `deliverToPrOps.ts:42-45` → "`sandboxRef` is the sandbox head sha the fetch resolved. The `--no-write-fetch-head` flag only keeps this advisory fetch from truncating FETCH_HEAD for other readers."; `sessionRunner.ts:125` → "fetch the clone's branch into the private ref `refs/karst/sandbox/<branch>` (never FETCH_HEAD); merges nothing (carry classification)."

- [ ] **Step 4: Run** — the three unit files plus `npx vitest run --config vitest.integration.config.ts src/extension/ops/sandboxRewrite.integration.test.ts src/extension/ops/deliverToPrOps.integration.test.ts` → PASS. `grep -rn FETCH_HEAD src --include='*.ts' | grep -v "\.test\.\|cloneRefresh"` → no hits.

- [ ] **Step 5: Commit** — `git add src docs && git commit -m "fix: host-side sandbox divergence and carry read the private ref"`

---

### Task 5: Docs and final gates

**Files:**
- Modify: `docs/arch/agent-cores.md` — block `[@arch:AC-39]`, item (5): "the result is `FETCH_HEAD`, fast-forward or refuse." → "the result is the private ref `refs/karst/sandbox/<branch>` (`--no-write-fetch-head`, forced refspec), resolved ONCE to a sha that classify, `merge --ff-only` and `diff` all use; `FETCH_HEAD` is shared by every fetch in the worktree and is never read. An unreadable ref is a refusal (`cannot read the sandbox head`), never `diverged`; fast-forward or refuse."

- [ ] **Step 1:** Edit the sentence above (find it with `grep -n "the result is" docs/arch/agent-cores.md`; keep the keyed-block format).
- [ ] **Step 2: Gates**
  - `npm run -s typecheck`
  - `npm run -s docs:graph -- --check` (system-map must be unchanged; if it drifts, run `npm run -s docs:graph` and commit)
  - `npx stryker run --mutate src/agent/cloneSyncClass.ts src/extension/ops/sandboxRewrite.ts src/extension/ops/sandboxCarryOp.ts && node scripts/mutationSummary.mjs` → score ≥ 85; add tests for surviving mutants (e.g. `resolveSandboxHead` regex bound, `--no-write-fetch-head` presence).
  - `npm run -s test:unit 2>&1 | tail -15` once; rerun only failing files.
- [ ] **Step 3: Commit** — `git add docs && git commit -m "docs: AC-39 sync reads the private sandbox ref"`

---

## Self-Review

- **Spec coverage:** (1) private ref + `--no-write-fetch-head` + resolve once + sha for classify/merge/diff/`ref` → Tasks 1-3. (2) classifier takes sha; unresolvable → error → Task 1 (`resolveSandboxHead`, tests). (3) consumers: sandboxRewrite, sandboxCarryOp → Task 4; sandboxSyncOps (classification goes through `classifyDivergence`, comments only) and deliverToPrOps (comment, flag kept) → Task 4. (4) REFRESH_SCRIPT untouched → Global Constraints. (5) AC-39 → Task 5. Tests: per-runner "FETCH_HEAD never read / sync still ff" → Tasks 2-3; unresolvable → Tasks 1-3; updated asserting tests → Tasks 2-4.
- **Placeholders:** none; Task 4 test edits name file+line and the exact replacement.
- **Types:** `resolveSandboxHead` returns `{ok:false,reason}` which is assignable to `SyncResult`/`DiffResult`/`StepResult` failure shapes; `classifyCloneRelation(sha, fn)` used identically in Tasks 2-3; `sandboxHeadRef(branch)` used in Task 4.
