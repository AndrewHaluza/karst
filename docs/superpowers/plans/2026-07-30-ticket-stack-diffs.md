# Ticket Stack Diffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreliable per-worktree Source Control redirect with one ticket-wide explorer for commits, staged changes, unstaged changes, and untracked files that opens exact native VS Code diffs.

**Architecture:** Async Git plumbing produces host-agnostic worktree inspections, then a ticket snapshot assigns generation-specific opaque change ids and isolates repository failures. A host-agnostic panel manager owns refresh/routing, while a standalone webview renders the hierarchy and a thin activation adapter materializes trusted diff targets into native `vscode.diff` editors.

**Tech Stack:** TypeScript/ESM, VS Code extension APIs, Node `child_process` through the existing async `GitRunner`, standalone CSP-protected HTML, Vitest, temporary real Git repositories.

## Global Constraints

- Follow strict RED → GREEN TDD: no production change before its focused test fails for the expected missing behavior.
- All extension-host Git calls use the existing asynchronous `GitRunner`; never use `spawnSync` on this path.
- Runtime modules outside `src/extension.ts` do not import `vscode`.
- Webview messages never carry filesystem paths, revisions, or Git object expressions; only a generation-specific opaque `changeId`.
- ESM imports include `.js`; preserve `noUncheckedIndexedAccess` guards.
- Source webview assets live under `src/`; never edit `dist/` directly.
- The explorer is read-only and performs no stage, unstage, commit, discard, branch, or worktree mutation.
- Git-backed text sides are limited to 5 MiB; truncated/binary/unreadable content stays listed and refuses a text diff clearly.
- Commits use the recorded worktree `baseRef`, `merge-base`, and first-parent history; never guess another base.

---

### Task 1: Read Git-native worktree history and exact diff resources

**Files:**

- Create: `src/ui/diffs/git.ts`
- Create: `src/ui/diffs/git.test.ts`
- Reuse: `src/integrations/git.ts`
- Reuse: `src/runtime/boundedOutput.ts`

**Interfaces:**

- Consumes: `GitRunner = (args: string[], cwd: string) => Promise<GitResult>` from `src/integrations/git.ts`.
- Produces:

```ts
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type DiffSource =
  | { kind: 'empty'; label: string }
  | { kind: 'git'; revision: string; path: string; label: string }
  | { kind: 'index'; path: string; label: string }
  | { kind: 'working'; path: string; label: string };

export interface DiffTarget {
  repoLabel: string;
  groupLabel: string;
  displayPath: string;
  left: DiffSource;
  right: DiffSource;
  binaryCheck:
    | { kind: 'commit'; parent: string; commit: string; path: string }
    | { kind: 'staged'; path: string }
    | { kind: 'unstaged'; path: string }
    | { kind: 'untracked'; path: string };
}

export interface InspectedFile {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
  target: DiffTarget;
}

export interface InspectedCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
  files: InspectedFile[];
}

export interface WorktreeSpec {
  label: string;
  path: string;
  branch: string | null;
  baseRef: string | null;
}

export interface InspectedWorktree {
  spec: WorktreeSpec;
  commits: InspectedCommit[];
  staged: InspectedFile[];
  unstaged: InspectedFile[];
  untracked: InspectedFile[];
}

export type PreparedDiffResource =
  | { kind: 'virtual'; label: string; content: string }
  | { kind: 'file'; label: string; path: string };

export interface PreparedDiff {
  title: string;
  left: PreparedDiffResource;
  right: PreparedDiffResource;
}

export const DIFF_CONTENT_MAX_BYTES = 5 * 1024 * 1024;

export async function inspectWorktree(
  git: GitRunner,
  spec: WorktreeSpec,
): Promise<InspectedWorktree>;

export async function prepareDiff(
  git: GitRunner,
  target: DiffTarget,
  workingFile: {
    stat(path: string): Promise<{ size: number }>;
    read(path: string): Promise<Buffer>;
  },
): Promise<PreparedDiff>;
```

- `inspectWorktree` throws a reason naming the worktree on an invalid/missing
  base or truncated Git result. Task 2 catches it per worktree.
- `prepareDiff` throws `TextDiffUnavailableError` for binary, truncated,
  unreadable, or over-5-MiB text resources.

- [ ] **Step 1: Write failing parser tests**

Add literal `parseNameStatus` cases before exporting the implementation:

```ts
it('parses NUL-delimited adds, deletes, and renames without splitting spaces', () => {
  expect(parseNameStatus('A\0new file.ts\0D\0gone.ts\0R100\0old name.ts\0new name.ts\0'))
    .toEqual([
      { status: 'added', path: 'new file.ts', oldPath: null },
      { status: 'deleted', path: 'gone.ts', oldPath: null },
      { status: 'renamed', path: 'new name.ts', oldPath: 'old name.ts' },
    ]);
});
```

Add commit-token tests with hand-written NUL fields and assert malformed field
counts throw rather than silently returning a partial list.

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
npx vitest run src/ui/diffs/git.test.ts
```

Expected: FAIL because `parseNameStatus`/`parseCommitHeaders` are not exported.

- [ ] **Step 3: Implement strict NUL-delimited parsers**

Use a cursor over `output.split('\0')`; consume one path after ordinary status
tokens and old/new paths after `R<score>`/`C<score>`. Map `A`, `D`, and `R*` to
the exact public statuses and every other tracked-file status to `modified`.
Reject an unexpected end, empty required path, truncated-output marker, or
incomplete commit record.

Commit records use:

```ts
[
  'log',
  '--first-parent',
  '-z',
  '--format=%H%x00%h%x00%an%x00%aI%x00%s',
  `${mergeBase}..HEAD`,
]
```

The parser consumes exactly five non-NUL fields per record and trims only the
record separator, never filenames or commit subjects.

- [ ] **Step 4: Write failing real-Git inspection tests**

Create temporary repositories with `mkdtempSync`, configure a local test
identity, and use test-only `execFileSync('git', args, {cwd})` for fixture
setup. Cover:

```ts
it('lists first-parent commits since base newest-first with exact commit files');
it('separates staged, unstaged, staged-plus-unstaged, and untracked paths');
it('keeps clean worktrees and paths containing spaces');
it('preserves added, deleted, and renamed old/new paths');
it('rejects an invalid recorded base instead of guessing');
```

For staged-plus-unstaged, commit `value=1`, write `value=2`, `git add`, then
write `value=3`; assert the path occurs once in `staged` and once in
`unstaged`, with distinct `DiffTarget` sides.

- [ ] **Step 5: Run the real-Git tests and verify RED**

Run:

```bash
npx vitest run src/ui/diffs/git.test.ts
```

Expected: parser tests pass; inspection tests FAIL because
`inspectWorktree` is missing.

- [ ] **Step 6: Implement worktree inspection**

Run every command through the injected `GitRunner` and reject non-zero exits
with stderr/stdout/exit-code fallback:

```ts
const head = await gitText(git, ['rev-parse', '--verify', 'HEAD^{commit}'], spec.path);
const base = await gitText(
  git,
  ['rev-parse', '--verify', `${spec.baseRef}^{commit}`],
  spec.path,
);
const mergeBase = await gitText(git, ['merge-base', head.trim(), base.trim()], spec.path);
```

For every commit, compare its first parent to itself with
`git diff-tree --no-commit-id --name-status -z -r -M <parent> <commit>`.
Use Git's empty-tree id for a root commit. Pending commands are:

```ts
['diff', '--cached', '--name-status', '-z', '-M', 'HEAD']
['diff', '--name-status', '-z', '-M']
['ls-files', '--others', '--exclude-standard', '-z']
```

Create `DiffTarget` sides as follows:

- commit: `<commit>^1:<oldPath>` (or empty for add) → `<commit>:<path>`
  (or empty for delete);
- staged: `HEAD:<oldPath>` (or empty) → `:<path>` (or empty);
- unstaged: `:<oldPath>` (or empty) → working absolute path (or empty);
- untracked: empty → working absolute path.

Use `join(spec.path, relativePath)` only for trusted paths returned by Git and
reject a resolved path that escapes `spec.path`.

- [ ] **Step 7: Write failing exact-content tests**

Against the same real repository, call `prepareDiff` for one file from each
group and assert literal left/right contents:

```ts
expect(staged.left).toMatchObject({ kind: 'virtual', content: 'value=1\n' });
expect(staged.right).toMatchObject({ kind: 'virtual', content: 'value=2\n' });
expect(unstaged.left).toMatchObject({ kind: 'virtual', content: 'value=2\n' });
expect(unstaged.right).toMatchObject({ kind: 'file' });
```

Also assert added/deleted empty sides, rename labels, binary refusal, and
5-MiB refusal. Derive expected strings directly from fixture writes, never by
calling a production helper.

- [ ] **Step 8: Run exact-content tests and verify RED**

Run:

```bash
npx vitest run src/ui/diffs/git.test.ts
```

Expected: inspection tests pass; content tests FAIL because `prepareDiff` is
missing.

- [ ] **Step 9: Implement lazy exact-content preparation**

Before loading content:

- run the target-specific `git diff --numstat` form and reject `-\t-` as binary;
- for untracked working files, read the first 8 KiB and reject a NUL byte;
- use `git cat-file -s <revision>:<path>` or filesystem `stat` for the 5-MiB cap;
- read Git/index text with `git show <revision>:<path>` / `git show :<path>`;
- return real working paths as `{kind:'file'}` so VS Code reads the live file;
- return empty and immutable sides as virtual strings.

Treat `OUTPUT_TRUNCATION_MARKER` as refusal, never as file content.

- [ ] **Step 10: Verify Task 1 GREEN and commit**

Run:

```bash
npx vitest run src/ui/diffs/git.test.ts
git diff --check
git add src/ui/diffs/git.ts src/ui/diffs/git.test.ts
git commit -m "feat: inspect worktree git changes"
```

Expected: all focused tests PASS; diff check exits 0.

---

### Task 2: Aggregate ticket snapshots with opaque, non-reusable change ids

**Files:**

- Create: `src/ui/diffs/snapshot.ts`
- Create: `src/ui/diffs/snapshot.test.ts`
- Reuse: `src/ui/diffs/git.ts`

**Interfaces:**

- Consumes: `WorktreeSpec`, `InspectedWorktree`, `DiffTarget`, and
  `inspectWorktree` from Task 1.
- Produces:

```ts
export interface ChangedFileView {
  changeId: string;
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
}

export interface CommitView {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
  files: ChangedFileView[];
}

export interface WorktreeChangesView {
  label: string;
  branch: string | null;
  baseRef: string | null;
  commits: CommitView[];
  staged: ChangedFileView[];
  unstaged: ChangedFileView[];
  untracked: ChangedFileView[];
  error: string | null;
}

export interface TicketChangesState {
  ticketId: number;
  worktreeCount: number;
  commitCount: number;
  pendingCount: number;
  worktrees: WorktreeChangesView[];
}

export interface TicketChangesSnapshot {
  state: TicketChangesState;
  targets: ReadonlyMap<string, DiffTarget>;
}

export async function buildTicketChangesSnapshot(
  ticketId: number,
  worktrees: readonly WorktreeSpec[],
  inspect?: (spec: WorktreeSpec) => Promise<InspectedWorktree>,
  makePrefix?: () => string,
): Promise<TicketChangesSnapshot>;
```

- Default `makePrefix` uses `randomBytes(16).toString('hex')`; tests inject a
  literal prefix.

- [ ] **Step 1: Write failing aggregation/security tests**

Use two successful inspected fixtures and one throwing inspector:

```ts
it('combines every physical worktree and reports commits separately from pending entries');
it('keeps a failed worktree as an inline error while successful worktrees remain');
it('maps every actionable row to its trusted DiffTarget');
it('never reuses a change id across snapshot generations');
```

Assert exact counts: `commitCount` is commit objects; `pendingCount` is staged +
unstaged + untracked rows and does not include commit files.

- [ ] **Step 2: Run snapshot tests and verify RED**

Run:

```bash
npx vitest run src/ui/diffs/snapshot.test.ts
```

Expected: FAIL because the snapshot module does not exist.

- [ ] **Step 3: Implement parallel, failure-isolated aggregation**

Call the inspector for all worktrees with `Promise.all`, catching inside each
mapped promise:

```ts
const settled = await Promise.all(
  worktrees.map(async (spec) => {
    try {
      return { spec, inspected: await inspect(spec), error: null };
    } catch (error) {
      return { spec, inspected: null, error: errorMessage(error) };
    }
  }),
);
```

Generate ids `${prefix}:${counter}` while converting host-only inspected files
to serializable rows. Insert every id and target into the map exactly once.
Failed worktrees retain label/branch/base with empty groups and a reason.

- [ ] **Step 4: Verify Task 2 GREEN and commit**

Run:

```bash
npx vitest run src/ui/diffs/snapshot.test.ts src/ui/diffs/git.test.ts
git diff --check
git add src/ui/diffs/snapshot.ts src/ui/diffs/snapshot.test.ts
git commit -m "feat: build ticket change snapshots"
```

Expected: all focused tests PASS.

---

### Task 3: Add the secure, latest-result-wins changes panel manager

**Files:**

- Create: `src/ui/diffs/messages.ts`
- Create: `src/ui/diffs/messages.test.ts`
- Create: `src/ui/diffs/panel.ts`
- Create: `src/ui/diffs/panel.test.ts`
- Reuse: `src/logging/logger.ts`
- Reuse: `src/ui/diffs/snapshot.ts`

**Interfaces:**

```ts
export type ChangesWebviewMessage =
  | { type: 'refresh' }
  | { type: 'open-diff'; changeId: string };

export type ChangesHostMessage =
  | { type: 'loading'; state: TicketChangesState | null }
  | { type: 'state'; state: TicketChangesState }
  | { type: 'error'; message: string };

export interface ChangesPanel {
  reveal(): void;
  postMessage(message: ChangesHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

export interface ChangesPanelHost {
  createPanel(title: string, ticketId: number): ChangesPanel;
}

export class TicketChangesManager {
  constructor(
    host: ChangesPanelHost,
    titleFor: (ticketId: number) => string,
    load: (ticketId: number) => Promise<TicketChangesSnapshot>,
    openDiff: (target: DiffTarget) => Promise<void>,
    warn: (message: string) => void,
    logError?: LogError,
  );
  open(ticketId: number): void;
  isOpen(ticketId: number): boolean;
}
```

- [ ] **Step 1: Write failing message-boundary tests**

Assert:

```ts
expect(parseChangesMessage({ type: 'refresh' })).toEqual({ type: 'refresh' });
expect(parseChangesMessage({ type: 'open-diff', changeId: 'g1:4' }))
  .toEqual({ type: 'open-diff', changeId: 'g1:4' });
expect(parseChangesMessage({ type: 'open-diff', path: '/tmp/x' })).toBeNull();
expect(parseChangesMessage({ type: 'open-diff', changeId: '' })).toBeNull();
```

Route tests assert the validated id reaches `openDiff` and unknown shapes do
nothing.

- [ ] **Step 2: Run message tests and verify RED**

Run:

```bash
npx vitest run src/ui/diffs/messages.test.ts
```

Expected: FAIL because `messages.ts` does not exist.

- [ ] **Step 3: Implement the two-message whitelist**

Use an object/null guard and a switch. `refresh` drops all companion payload;
`open-diff` requires a non-empty string `changeId`. Do not define path, repo,
revision, or commit fields in the protocol.

- [ ] **Step 4: Write failing panel lifecycle/concurrency tests**

Create a `FakePanel`, deferred promises, and literal snapshots. Cover:

```ts
it('posts loading then state on first open');
it('reveals and refreshes the existing panel instead of duplicating it');
it('retains the last successful state while refreshing');
it('lets only the newest overlapping refresh replace state and target lookup');
it('opens only a target from the current snapshot map');
it('warns and refreshes for a stale or forged change id');
it('isolates an openDiff rejection and keeps routing later messages');
it('posts nothing after disposal and recreates on the next open');
```

For the concurrency test, resolve refresh 2 first and refresh 1 last; assert no
state/target from refresh 1 becomes current.

- [ ] **Step 5: Run panel tests and verify RED**

Run:

```bash
npx vitest run src/ui/diffs/panel.test.ts src/ui/diffs/messages.test.ts
```

Expected: message tests pass; panel tests FAIL because `TicketChangesManager`
does not exist.

- [ ] **Step 6: Implement panel sessions and request generations**

Store per ticket:

```ts
interface PanelSession {
  panel: ChangesPanel;
  requestId: number;
  snapshot: TicketChangesSnapshot | null;
  disposed: boolean;
}
```

`refresh` increments `requestId`, posts `{type:'loading', state:lastState}`, and
applies success/error only when the session is still current, not disposed, and
the id matches. Reopening calls `reveal()` and starts `refresh`.

On `open-diff`, resolve only from `session.snapshot.targets`. A miss calls
`warn('That change is stale. Refreshing ticket changes…')` and refreshes. Catch
`openDiff` errors through `logError` and warn with the thrown reason without
removing the snapshot.

- [ ] **Step 7: Verify Task 3 GREEN and commit**

Run:

```bash
npx vitest run src/ui/diffs/messages.test.ts src/ui/diffs/panel.test.ts
git diff --check
git add src/ui/diffs/messages.ts src/ui/diffs/messages.test.ts src/ui/diffs/panel.ts src/ui/diffs/panel.test.ts
git commit -m "feat: manage ticket changes panels"
```

Expected: all focused tests PASS.

---

### Task 4: Build the Git-state explorer webview and package it

**Files:**

- Create: `src/ui/diffs/webview.html`
- Create: `src/ui/diffs/webview.test.ts`
- Modify: `src/ui/webviewCsp.test.ts`
- Modify: `scripts/copy-assets.mjs`

**Interfaces:**

- Consumes `ChangesHostMessage` states from Task 3.
- Emits only `{type:'refresh'}` and `{type:'open-diff', changeId}`.
- Uses host-provided `TicketChangesState`; no Git decisions are made in HTML.

- [ ] **Step 1: Make CSP discovery fail for the new webview**

Add `'diffs'` to the literal expected directory list in
`src/ui/webviewCsp.test.ts`.

- [ ] **Step 2: Run CSP discovery and verify RED**

Run:

```bash
npx vitest run src/ui/webviewCsp.test.ts
```

Expected: FAIL because discovery still finds only dashboard, onboarding,
settings, sidebar, and welcome.

- [ ] **Step 3: Add the minimal secure webview shell**

Create an HTML document containing `<!--KARST_CSP-->`, VS Code theme variables,
one attribute-less `<script>`, and these stable roots:

```html
<header>
  <div>
    <h1>Ticket changes</h1>
    <div id="summary" aria-live="polite"></div>
  </div>
  <button id="refresh" type="button">Refresh</button>
</header>
<label class="filter">
  <span class="sr">Filter files or commits</span>
  <input id="filter" type="search" placeholder="Filter files or commits…" />
</label>
<main id="repos" aria-live="polite"></main>
```

Acquire the API once with `acquireVsCodeApi()`. Refresh posts only its type.

- [ ] **Step 4: Run CSP discovery and verify GREEN**

Run:

```bash
npx vitest run src/ui/webviewCsp.test.ts
```

Expected: discovery finds six webviews and every CSP assertion passes.

- [ ] **Step 5: Write failing explorer contract tests**

In `webview.test.ts`, read the standalone HTML following the established
dashboard test pattern and assert the observable protocol/semantics:

```ts
it('renders Commits, Staged Changes, Changes, and Untracked Files');
it('posts opaque changeId values and never posts a path or revision');
it('uses details/summary controls for keyboard-accessible repository and commit expansion');
it('filters by repository, commit hash/message, and file path locally');
it('renders repository errors without replacing successful repositories');
it('keeps the prior state visible while loading');
```

- [ ] **Step 6: Run explorer tests and verify RED**

Run:

```bash
npx vitest run src/ui/diffs/webview.test.ts
```

Expected: FAIL because the minimal shell does not render the hierarchy.

- [ ] **Step 7: Implement the approved repository-first hierarchy**

Implement these pure webview functions inside the nonce-authorized script:

```js
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
const includes = (value, needle) => String(value ?? '').toLowerCase().includes(needle);

function fileMatches(file, needle) {
  return includes(file.path, needle) || includes(file.oldPath, needle);
}

function commitMatches(commit, needle) {
  return [commit.hash, commit.shortHash, commit.subject, commit.author]
    .some((value) => includes(value, needle))
    || commit.files.some((file) => fileMatches(file, needle));
}

function worktreeMatches(worktree, needle) {
  return [worktree.label, worktree.branch, worktree.baseRef]
    .some((value) => includes(value, needle))
    || worktree.commits.some((commit) => commitMatches(commit, needle))
    || [...worktree.staged, ...worktree.unstaged, ...worktree.untracked]
      .some((file) => fileMatches(file, needle));
}

const STATUS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

function fileRow(file) {
  const shown = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return `<button type="button" class="file" data-change-id="${esc(file.changeId)}">`
    + `<span class="file-path">${esc(shown)}</span>`
    + `<span class="status status-${esc(file.status)}">${STATUS[file.status] || 'M'}</span>`
    + `</button>`;
}

function pendingGroup(label, files) {
  if (!files.length) return '';
  return `<details class="group" open><summary>${esc(label)}`
    + `<span>${files.length}</span></summary>${files.map(fileRow).join('')}</details>`;
}

function commitRow(commit, index) {
  return `<details class="commit"${index === 0 ? ' open' : ''}>`
    + `<summary><code>${esc(commit.shortHash)}</code> ${esc(commit.subject)}`
    + `<span>${commit.files.length}</span></summary>`
    + `<div class="commit-meta">${esc(commit.author)} · ${esc(commit.authoredAt)}</div>`
    + `${commit.files.map(fileRow).join('')}</details>`;
}

function worktreeRow(worktree) {
  if (worktree.error) {
    return `<section class="repo error"><h2>${esc(worktree.label)}</h2>`
      + `<p>${esc(worktree.error)}</p></section>`;
  }
  const pending = worktree.staged.length + worktree.unstaged.length + worktree.untracked.length;
  const changed = worktree.commits.length + pending > 0;
  const subtitle = `${worktree.branch || 'detached'} ↔ ${worktree.baseRef || 'unknown base'}`;
  return `<details class="repo"${changed ? ' open' : ''}>`
    + `<summary><span><strong>${esc(worktree.label)}</strong>`
    + `<small>${esc(subtitle)}</small></span>`
    + `<span>${worktree.commits.length} commits · ${pending ? `${pending} pending` : 'clean'}</span>`
    + `</summary>`
    + `${worktree.commits.length
      ? `<details class="group" open><summary>COMMITS<span>${worktree.commits.length}</span></summary>`
        + `${worktree.commits.map(commitRow).join('')}</details>`
      : ''}`
    + pendingGroup('STAGED CHANGES', worktree.staged)
    + pendingGroup('CHANGES', worktree.unstaged)
    + pendingGroup('UNTRACKED FILES', worktree.untracked)
    + `</details>`;
}

function render(state, loading) {
  lastState = state;
  const needle = filter.value.trim().toLowerCase();
  summary.textContent = state
    ? `${state.worktreeCount} worktrees · ${state.commitCount} commits · ${state.pendingCount} pending`
    : 'No worktrees';
  const visible = state
    ? state.worktrees.filter((worktree) => !needle || worktreeMatches(worktree, needle))
    : [];
  repos.innerHTML = visible.length
    ? visible.map(worktreeRow).join('')
    : `<div class="empty">${needle ? 'No changes match this filter.' : 'No ticket worktrees.'}</div>`;
  refresh.disabled = loading;
  refresh.textContent = loading ? 'Refreshing…' : 'Refresh';
}
```

`fileRow` must emit:

```html
<button type="button" data-change-id="opaque-id">
  <span class="file-path">src/a.ts</span>
  <span class="status status-modified">M</span>
</button>
```

The delegated click handler posts the dataset id only:

```js
document.addEventListener('click', (event) => {
  const row = event.target.closest('[data-change-id]');
  if (row) vscode.postMessage({ type: 'open-diff', changeId: row.dataset.changeId });
});
```

Preserve the last state in `vscode.setState`; a loading message calls
`render(msg.state || lastState, true)`. Filtering updates locally and does not
post. Empty states distinguish no worktrees, all clean, and no filter matches.

- [ ] **Step 8: Add the runtime asset and verify packaging tests**

Append `'ui/diffs/webview.html'` to `assets` in `scripts/copy-assets.mjs`.

Run:

```bash
npx vitest run src/ui/diffs/webview.test.ts src/ui/webviewCsp.test.ts
npm run build
```

Expected: focused tests PASS and build output includes
`dist/ui/diffs/webview.html`.

- [ ] **Step 9: Commit Task 4**

Run:

```bash
git diff --check
git add src/ui/diffs/webview.html src/ui/diffs/webview.test.ts src/ui/webviewCsp.test.ts scripts/copy-assets.mjs
git commit -m "feat: add ticket changes explorer"
```

Expected: diff check exits 0 and commit succeeds.

---

### Task 5: Replace the dashboard redirect and wire native VS Code diffs

**Files:**

- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/extension.ts`
- Reuse: `src/ui/diffs/git.ts`
- Reuse: `src/ui/diffs/snapshot.ts`
- Reuse: `src/ui/diffs/panel.ts`
- Reuse: `src/store/dashboard.ts`
- Reuse: `src/ui/worktreePath.ts`

**Interfaces:**

- Dashboard protocol replaces `{type:'diff-worktree', path}` with
  `{type:'show-changes'}`.
- `DashboardActions` replaces `diffWorktree(path)` with `showChanges()`.
- Activation owns one `TicketChangesManager`, one `karst-diff` document provider,
  and the native diff-opening adapter.

- [ ] **Step 1: Write failing dashboard boundary tests**

Change the dashboard action fake and assertions:

```ts
routeAction({ type: 'show-changes', path: '/forged' }, actions);
expect(actions.showChanges).toHaveBeenCalledOnce();
expect(parseWebviewMessage({ type: 'diff-worktree', path: '/wt/a' })).toBeNull();
```

The companion path is deliberately dropped from the payload-free action. Add a
webview guard asserting `show-changes` exists once and `diff-worktree` no longer
exists.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run:

```bash
npx vitest run src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts
```

Expected: FAIL because the old per-worktree action is still implemented.

- [ ] **Step 3: Implement the ticket-level dashboard action**

In `messages.ts`, add the payload-free union member and route it to
`actions.showChanges()`. Remove `diffWorktree`.

In `webview.html`, change the Worktrees header to:

```html
<div class="phead">
  <span>Worktrees<span class="count" id="wtCount"></span></span>
  <button id="wtChanges" data-act="show-changes" type="button">Changes</button>
</div>
```

`renderWorktrees` disables `wtChanges` when `wts.length === 0`, removes the row
Diff button, and retains per-row `Open folder`.

- [ ] **Step 4: Run dashboard tests and verify GREEN**

Run:

```bash
npx vitest run src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing host-adapter tests at pure seams**

Extend Task 1/3 tests before activation wiring:

- `prepareDiff` title is
  `"<repoLabel> · <groupLabel> · <displayPath>"`;
- virtual resources contain only trusted prepared content;
- working resources contain only trusted absolute paths from the descriptor;
- manager passes the resolved `DiffTarget`, never `changeId`, to the host action.

Run:

```bash
npx vitest run src/ui/diffs/git.test.ts src/ui/diffs/panel.test.ts
```

Expected: FAIL on the new exact title/resource assertions until the pure
preparation seam matches the activation contract.

- [ ] **Step 6: Complete the pure preparation seam**

Return a `PreparedDiff` whose virtual labels are stable basenames with comparison
suffixes (`HEAD`, `index`, commit short hash, or `empty`) and whose title follows
the tested format. Do not put a filesystem path or Git expression into a
webview-facing value.

- [ ] **Step 7: Wire the changes manager during activation**

Before constructing `DashboardManager`, create `TicketChangesManager`:

```ts
const changes = new TicketChangesManager(
  makeChangesPanelHost(context),
  (ticketId) => `${ticketLabel(getTicket(localStore, ticketId))} — Changes`,
  async (ticketId) => {
    const pathContext = worktreePathContext(currentManifest(), logger.warn);
    const worktrees = listWorktreesByTicket(localStore, ticketId).map((w) => ({
      label: repoDisplayPath(w.repo, pathContext),
      path: w.path,
      branch: w.branch,
      baseRef: w.baseRef,
    }));
    return buildTicketChangesSnapshot(
      ticketId,
      worktrees,
      (spec) => inspectWorktree(defaultGitRunner, spec),
    );
  },
  (target) => openTicketDiff(target),
  (message) => void vscode.window.showWarningMessage(message),
  logError,
);
```

Import `repoDisplayPath` from `src/ui/worktreePath.ts`. Pass
`() => changes.open(ticketId)` into `makeDashboardActions` and return it as
`showChanges`.

Delete the old `git.openRepository`/`workbench.view.scm` action.

- [ ] **Step 8: Add the real changes panel host**

Following `makePanelHost`, load `ui/diffs/webview.html`, inject CSP with a fresh
nonce per panel, and create:

```ts
vscode.window.createWebviewPanel(
  'karst.changes',
  title,
  vscode.ViewColumn.Active,
  { enableScripts: true, retainContextWhenHidden: true },
);
```

Wrap only `reveal`, `postMessage`, `onDidReceiveMessage`, and `onDidDispose` in
the host-agnostic interface.

- [ ] **Step 9: Register virtual documents and open native diffs beside**

At activation, register scheme `karst-diff`. Keep a map from opaque URI string
to already-prepared text. Generate URIs with an incrementing host-owned token
and a sanitized basename; never encode a source path or revision into the URI.

```ts
context.subscriptions.push(
  vscode.workspace.registerTextDocumentContentProvider('karst-diff', {
    provideTextDocumentContent: (uri) => virtualDocuments.get(uri.toString()) ?? '',
  }),
  vscode.workspace.onDidCloseTextDocument((doc) => {
    if (doc.uri.scheme === 'karst-diff') virtualDocuments.delete(doc.uri.toString());
  }),
);
```

Create a content runner with the explicit diff bound:

```ts
const diffContentGit: GitRunner = (args, cwd) =>
  runGit(args, cwd, GIT_TIMEOUT_MS, DIFF_CONTENT_MAX_BYTES);
```

`openTicketDiff` awaits `prepareDiff(diffContentGit, target, fsAdapter)`.
Materialize virtual resources into the provider map and file resources with
`vscode.Uri.file`. Then run:

```ts
await vscode.commands.executeCommand(
  'vscode.diff',
  leftUri,
  rightUri,
  prepared.title,
  { preview: true, viewColumn: vscode.ViewColumn.Beside },
);
```

The filesystem adapter uses `node:fs/promises.stat/readFile`. Catch
`TextDiffUnavailableError` and show its reason; log unexpected errors.

- [ ] **Step 10: Run focused integration verification**

Run:

```bash
npx vitest run src/ui/diffs src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts src/ui/webviewCsp.test.ts
npm run typecheck
npm run build
```

Expected: all focused tests PASS, typecheck exits 0, and build copies the new
webview.

- [ ] **Step 11: Run the complete regression suite**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: the full Vitest suite has zero failures; diff check exits 0; status
contains only the intended Task 5 files plus any explicitly preserved local
visual-companion artifacts.

- [ ] **Step 12: Commit Task 5**

Run:

```bash
git add src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts src/extension.ts
git commit -m "feat: open native ticket stack diffs"
```

Expected: commit succeeds with no unrelated files staged.

---

### Task 6: Review, verify, and advance the Karst ticket

**Files:**

- Review all files changed by Tasks 1–5.
- No new production file is expected unless review finds a concrete defect.

- [ ] **Step 1: Run the mandatory code review**

Invoke the project-required TypeScript/JavaScript code reviewer on the complete
diff. Check specifically:

- argv-only Git safety and NUL parsing;
- base-ref/first-parent correctness;
- event-loop freedom;
- stale refresh/change-id behavior;
- path containment and webview trust boundary;
- provider entry cleanup;
- accessible keyboard navigation and escaped HTML;
- no blocking VS Code activation behavior.

- [ ] **Step 2: Fix each accepted review finding with RED → GREEN**

For every behavioral finding, add the smallest failing test, run it to confirm
the expected failure, implement the fix, and rerun the focused test. Do not
change code merely to satisfy stylistic preference.

- [ ] **Step 3: Run fresh completion verification**

Run:

```bash
npx vitest run src/ui/diffs src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts src/ui/webviewCsp.test.ts
npm run typecheck
npm run build
npm test
git diff --check
git status --short
```

Expected: every command exits 0; the full suite reports zero failing tests.

- [ ] **Step 4: Commit review fixes if any**

If review produced fixes:

```bash
git add src/ui/diffs src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts src/ui/webviewCsp.test.ts src/extension.ts scripts/copy-assets.mjs
git commit -m "fix: harden ticket stack diffs"
```

If there were no fixes, do not create an empty commit.

- [ ] **Step 5: Record implementation completion**

Run the exact ticket marker:

```bash
node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket show-wt-diffs
```

Expected: JSON confirms the `impl` pass marker and transition to the next
ticket stage.
