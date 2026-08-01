# Dashboard Worktree Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each dashboard worktree row into a compact navigation and status surface with line totals, terminal/reveal actions, branch copying, and an icon-only ticket-diff control.

**Architecture:** Keep the synchronous SQLite-backed `DashboardState` unchanged and compute live line totals through an injected async Git loader. `DashboardManager` delivers totals in a separate ephemeral host message with request-version and panel-liveness guards; the standalone webview keeps the latest totals map. VS Code effects are wrapped by a small host-agnostic adapter so all action sequencing remains testable without importing `vscode` under Vitest.

**Tech Stack:** TypeScript 5, ESM, Vitest, VS Code extension APIs, async injected `GitRunner`, standalone HTML/CSS/JavaScript webview.

## Global Constraints

- Follow strict RED → GREEN TDD for every behavior.
- Keep `buildDashboardState` synchronous; line totals must not be stored in SQLite or added to `DashboardState`.
- Compare each worktree with its recorded `baseRef` using `git diff --numstat`; include committed and tracked staged/unstaged changes, exclude untracked files, and ignore binary numstat rows.
- Run Git asynchronously through injected `GitRunner`; never block the extension-host event loop.
- Validate every webview payload before it reaches VS Code APIs.
- Runtime TypeScript imports use `.js` suffixes; no module imported by Vitest may import `vscode` at runtime.
- Edit `src/ui/dashboard/webview.html`, never its generated `dist/` copy.
- Completion requires `npm test`, `npm run typecheck`, `npm run build`, diff checks, and the exact ticket implementation-stage marker.

## File Structure

- Create `src/ui/dashboard/worktreeStats.ts`: parse `--numstat` output and load per-worktree totals through injected `GitRunner`.
- Create `src/ui/dashboard/worktreeStats.test.ts`: cover aggregation, binary rows, missing bases, command failures, truncation, and per-row isolation.
- Modify `src/ui/dashboard/messages.ts`: add validated worktree terminal/copy messages and the ephemeral stats host message.
- Modify `src/ui/dashboard/messages.test.ts`: prove the new messages parse, route, and reject empty/non-string payloads.
- Modify `src/ui/dashboard/panel.ts`: invoke an optional async stats loader after state pushes and discard stale/disposed results.
- Modify `src/ui/dashboard/panel.test.ts`: verify successful, stale, disposed, and rejected async deliveries.
- Modify `src/ui/dashboard/webview.html`: add icons, accessible controls, copy behavior, stats rendering, and clarified actions.
- Modify `src/ui/dashboard/webview.test.ts`: lock down the new markup, accessible names, action payloads, and ephemeral stats handling.
- Create `src/ui/dashboard/worktreeActions.ts`: sequence terminal, clipboard, reveal, and Explorer expansion effects behind injected interfaces.
- Create `src/ui/dashboard/worktreeActions.test.ts`: verify exact host calls, ordering, and contained rejected promises.
- Modify `src/extension.ts`: bind the new host-agnostic adapters to VS Code and inject the Git stats loader into `DashboardManager`.

---

### Task 1: Async Git Worktree Statistics

**Files:**
- Create: `src/ui/dashboard/worktreeStats.ts`
- Create: `src/ui/dashboard/worktreeStats.test.ts`

**Interfaces:**
- Consumes: `GitRunner` from `src/integrations/git.ts` and `WorktreeView` from `src/store/dashboard.ts`.
- Produces: `WorktreeStats { repo: string; additions: number; deletions: number }`, `WorktreeStatsLoader`, `parseNumstat(stdout)`, and `loadWorktreeStats(worktrees, git, logError)`.

- [ ] **Step 1: Write failing parser and loader tests**

Create `src/ui/dashboard/worktreeStats.test.ts` with focused cases using a `GitRunner` fake:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import type { WorktreeView } from '../../store/dashboard.js';
import { loadWorktreeStats, parseNumstat } from './worktreeStats.js';

const wt = (overrides: Partial<WorktreeView> = {}): WorktreeView => ({
  ticketId: 1,
  repo: '/repo/a',
  repoDisplay: '/repo/a',
  path: '/repo/a/.karst/worktrees/A',
  branch: 'karst/A',
  baseRef: 'develop',
  depsMode: 'inherited',
  ...overrides,
});

describe('parseNumstat', () => {
  it('sums text rows and ignores binary or malformed rows', () => {
    expect(parseNumstat('10\t2\tsrc/a.ts\n4\t0\tsrc/b.ts\n-\t-\tlogo.png\nbad\n')).toEqual({
      additions: 14,
      deletions: 2,
    });
  });
});

describe('loadWorktreeStats', () => {
  it('runs one base-to-working-tree numstat diff and returns repo-keyed totals', async () => {
    const git: GitRunner = vi.fn().mockResolvedValue({
      stdout: '200\t24\tsrc/a.ts\n', stderr: '', exitCode: 0,
    });
    await expect(loadWorktreeStats([wt()], git, vi.fn())).resolves.toEqual([
      { repo: '/repo/a', additions: 200, deletions: 24 },
    ]);
    expect(git).toHaveBeenCalledWith(
      ['diff', '--numstat', '--no-ext-diff', 'develop', '--'],
      '/repo/a/.karst/worktrees/A',
    );
  });

  it('skips a missing base and isolates failed or truncated worktrees', async () => {
    const logError = vi.fn();
    const git: GitRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'bad ref', exitCode: 128 })
      .mockResolvedValueOnce({ stdout: '1\t1\tx\n', stdoutTruncated: true, stderr: '', exitCode: 0 });
    const rows = [
      wt({ repo: '/no-base', baseRef: null }),
      wt({ repo: '/failed', path: '/failed' }),
      wt({ repo: '/truncated', path: '/truncated' }),
    ];
    await expect(loadWorktreeStats(rows, git, logError)).resolves.toEqual([]);
    expect(git).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `npx vitest run src/ui/dashboard/worktreeStats.test.ts`

Expected: FAIL because `./worktreeStats.js` does not exist.

- [ ] **Step 3: Implement numeric parsing and isolated async loading**

Create `src/ui/dashboard/worktreeStats.ts`:

```ts
import type { GitRunner } from '../../integrations/git.js';
import type { LogError } from '../../logging/logger.js';
import type { WorktreeView } from '../../store/dashboard.js';

export interface WorktreeStats {
  repo: string;
  additions: number;
  deletions: number;
}

export type WorktreeStatsLoader = (
  worktrees: readonly WorktreeView[],
) => Promise<WorktreeStats[]>;

export function parseNumstat(stdout: string): Omit<WorktreeStats, 'repo'> {
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split('\n')) {
    const [added, deleted] = line.split('\t', 3);
    if (!added || !deleted || !/^\d+$/.test(added) || !/^\d+$/.test(deleted)) continue;
    const nextAdditions = additions + Number(added);
    const nextDeletions = deletions + Number(deleted);
    if (!Number.isSafeInteger(nextAdditions) || !Number.isSafeInteger(nextDeletions)) continue;
    additions = nextAdditions;
    deletions = nextDeletions;
  }
  return { additions, deletions };
}

export async function loadWorktreeStats(
  worktrees: readonly WorktreeView[],
  git: GitRunner,
  logError: LogError,
): Promise<WorktreeStats[]> {
  const rows = await Promise.all(worktrees.map(async (worktree): Promise<WorktreeStats | null> => {
    if (!worktree.baseRef) return null;
    try {
      const result = await git(
        ['diff', '--numstat', '--no-ext-diff', worktree.baseRef, '--'],
        worktree.path,
      );
      if (result.exitCode !== 0 || result.stdoutTruncated) {
        throw new Error(result.stderr || 'git diff output was truncated');
      }
      return { repo: worktree.repo, ...parseNumstat(result.stdout) };
    } catch (error) {
      logError(`karst: could not read worktree stats for ${worktree.path}`, error);
      return null;
    }
  }));
  return rows.filter((row): row is WorktreeStats => row !== null);
}
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `npx vitest run src/ui/dashboard/worktreeStats.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the statistics module**

```bash
git add src/ui/dashboard/worktreeStats.ts src/ui/dashboard/worktreeStats.test.ts
git commit -m "feat: compute dashboard worktree change totals"
```

---

### Task 2: Validated Protocol and Stale-Safe Stats Delivery

**Files:**
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/dashboard/panel.test.ts`

**Interfaces:**
- Consumes: `WorktreeStats` and `WorktreeStatsLoader` from Task 1.
- Produces: webview messages `open-worktree-terminal` and `copy-worktree-branch`, host message `worktree-stats`, dashboard actions `openWorktreeTerminal(path)` and `copyWorktreeBranch(branch)`, plus optional final `DashboardManager` constructor dependency `loadStats?: WorktreeStatsLoader`.

- [ ] **Step 1: Write failing message-boundary tests**

Extend the `actions()` fake and add assertions in `src/ui/dashboard/messages.test.ts`:

```ts
openWorktreeTerminal: vi.fn(),
copyWorktreeBranch: vi.fn(),
```

```ts
it('validates and dispatches worktree terminal and branch-copy actions', () => {
  const a = actions();
  routeAction({ type: 'open-worktree-terminal', path: '/wt/a' }, a);
  routeAction({ type: 'copy-worktree-branch', branch: 'karst/A' }, a);
  expect(a.openWorktreeTerminal).toHaveBeenCalledWith('/wt/a');
  expect(a.copyWorktreeBranch).toHaveBeenCalledWith('karst/A');
});

it('rejects empty or non-string worktree action payloads', () => {
  expect(parseWebviewMessage({ type: 'open-worktree-terminal', path: '' })).toBeNull();
  expect(parseWebviewMessage({ type: 'copy-worktree-branch', branch: '' })).toBeNull();
  expect(parseWebviewMessage({ type: 'copy-worktree-branch', branch: 4 })).toBeNull();
});
```

- [ ] **Step 2: Run message tests to verify RED**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`

Expected: FAIL because the new action fields and discriminants are absent.

- [ ] **Step 3: Implement parsing and routing**

In `src/ui/dashboard/messages.ts`:

```ts
import type { WorktreeStats } from './worktreeStats.js';
```

Add to `WebviewMessage`:

```ts
| { type: 'open-worktree-terminal'; path: string }
| { type: 'copy-worktree-branch'; branch: string }
```

Add to `HostMessage`:

```ts
| { type: 'worktree-stats'; stats: WorktreeStats[] }
```

Add to `DashboardActions`:

```ts
openWorktreeTerminal: (path: string) => void;
copyWorktreeBranch: (branch: string) => void;
```

Narrow `branch` beside `path`, add both switch cases in `parseWebviewMessage`, and route them exactly:

```ts
const branch = typeof m.branch === 'string' && m.branch.length > 0;
// ...
case 'open-worktree-terminal':
  return path ? { type: 'open-worktree-terminal', path: m.path as string } : null;
case 'copy-worktree-branch':
  return branch ? { type: 'copy-worktree-branch', branch: m.branch as string } : null;
// ...
case 'open-worktree-terminal':
  actions.openWorktreeTerminal(msg.path);
  return;
case 'copy-worktree-branch':
  actions.copyWorktreeBranch(msg.branch);
  return;
```

- [ ] **Step 4: Run message tests to verify GREEN**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing async manager tests**

In `src/ui/dashboard/panel.test.ts`, insert a worktree row for the ticket, inject deferred `WorktreeStatsLoader` promises as the last constructor argument, and add these behaviors:

```ts
it('posts loaded worktree stats after the synchronous state', async () => {
  const t = createTicket(store, { key: 'A', title: 'a' });
  store.db.prepare(
    'INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)',
  ).run(t.id, '/repo/a', '/wt/a', 'karst/A', 'develop');
  const { host, panels } = fakeHost();
  const loadStats = vi.fn().mockResolvedValue([{ repo: '/repo/a', additions: 8, deletions: 3 }]);
  const mgr = new DashboardManager(
    store, host, () => ({}) as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, loadStats,
  );
  mgr.openDashboard(t.id);
  await vi.waitFor(() => expect(panels[0]!.posted).toContainEqual({
    type: 'worktree-stats',
    stats: [{ repo: '/repo/a', additions: 8, deletions: 3 }],
  }));
  expect(loadStats).toHaveBeenCalledWith([
    expect.objectContaining({ repo: '/repo/a', path: '/wt/a', baseRef: 'develop' }),
  ]);
});
```

Use two deferred promises for a second test: call `openDashboard`, then `pushState`; resolve the second request first and the first request last; assert only the second totals message is posted. Add a third test that disposes before resolution and expects no totals post, and a fourth whose loader rejects and expects `logError('karst: dashboard worktree stats failed', error)` without an unhandled rejection.

- [ ] **Step 6: Run manager tests to verify RED**

Run: `npx vitest run src/ui/dashboard/panel.test.ts`

Expected: FAIL because `DashboardManager` does not accept or invoke a totals loader.

- [ ] **Step 7: Implement request-versioned stats delivery**

In `src/ui/dashboard/panel.ts`, import `WorktreeStatsLoader`, add a request counter map and append the optional loader after `binding`:

```ts
private readonly statsRequests = new Map<number, number>();
// constructor final parameter
private readonly loadStats?: WorktreeStatsLoader,
```

After the normal state post in `pushState`, start the supplemental load:

```ts
panel.postMessage({ type: 'state', state });
this.pushWorktreeStats(ticketId, panel, state.worktrees);
this.refreshIcon(ticketId, panel);
```

Implement the stale/liveness guard:

```ts
private pushWorktreeStats(
  ticketId: number,
  panel: DashboardPanel,
  worktrees: DashboardState['worktrees'],
): void {
  if (!this.loadStats) return;
  const request = (this.statsRequests.get(ticketId) ?? 0) + 1;
  this.statsRequests.set(ticketId, request);
  void this.loadStats(worktrees).then(
    (stats) => {
      if (this.panels.get(ticketId) !== panel) return;
      if (this.statsRequests.get(ticketId) !== request) return;
      panel.postMessage({ type: 'worktree-stats', stats });
    },
    (error) => {
      if (this.panels.get(ticketId) !== panel) return;
      if (this.statsRequests.get(ticketId) !== request) return;
      this.logError('karst: dashboard worktree stats failed', error);
    },
  );
}
```

Import `DashboardState` as a type from `state.ts`. In the disposal handler delete the panel only when it is still the same instance and delete the request counter; the captured-panel comparison keeps a late response from an old panel out of a reopened panel.

- [ ] **Step 8: Run protocol and manager tests to verify GREEN**

Run: `npx vitest run src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the protocol and manager delivery**

```bash
git add src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts
git commit -m "feat: deliver worktree stats to dashboards"
```

---

### Task 3: Accessible Worktree Row UI

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: host messages `{ type: 'worktree-stats'; stats: WorktreeStats[] }` and the validated action names from Task 2.
- Produces: icon-only `show-changes`, terminal/copy/reveal controls, and visible `+N −N` totals keyed by `worktree.repo`.

- [ ] **Step 1: Write failing webview contract tests**

Add text-level tests to `src/ui/dashboard/webview.test.ts`:

```ts
it('renders ticket changes as an accessible diff icon button', () => {
  expect(HTML).toMatch(/id="wtChanges"[^>]*aria-label="Show ticket changes"/);
  expect(HTML).toContain('title="Show ticket changes"');
  expect(HTML).toContain("svgIcon('diff')");
  expect(HTML).not.toMatch(/id="wtChanges"[^>]*>Changes<\/button>/);
});

it('renders terminal, branch-copy, and reveal actions for each worktree', () => {
  expect(HTML).toContain('data-act="open-worktree-terminal"');
  expect(HTML).toContain('data-act="copy-worktree-branch"');
  expect(HTML).toContain('data-branch="${esc(w.branch)}"');
  expect(HTML).toContain('data-copy');
  expect(HTML).toContain('Open Terminal');
  expect(HTML).toContain('Reveal in Explorer');
  expect(HTML).not.toContain('>Open folder</button>');
});

it('renders ephemeral additions and deletions by host-owned repo identity', () => {
  expect(HTML).toMatch(/worktreeStats\[w\.repo\]/);
  expect(HTML).toContain('type === \'worktree-stats\'');
  expect(HTML).toContain('stats.additions');
  expect(HTML).toContain('stats.deletions');
});
```

- [ ] **Step 2: Run the webview test to verify RED**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`

Expected: FAIL on the old `Changes` text button, old `Open folder` action, missing new actions, and missing stats map.

- [ ] **Step 3: Add icons, compact row styles, and accessible controls**

In `src/ui/dashboard/webview.html`:

- Add `diff`, `terminal`, and `folder` symbols to the existing inline SVG sprite.
- Give the header button class `ib`, `aria-label="Show ticket changes"`, and `title="Show ticket changes"`, and render the `diff` glyph directly in the static markup.
- Extend `.wt` styles with `.wstats`, `.wadd`, `.wdel`, branch-copy grouping, and icon-button sizing while preserving one compact flex row.
- Keep positive additions and negative deletions semantically distinct using the theme's success/error foreground colors.

The header should have this shape:

```html
<button class="ib t-diff" id="wtChanges" data-act="show-changes" type="button"
  aria-label="Show ticket changes" title="Show ticket changes">
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#i-diff"/></svg>
</button>
```

- [ ] **Step 4: Render worktree controls and totals**

Declare `let worktreeStats = {};` beside the other ephemeral webview state. Rework `renderWorktrees` so every row follows this concrete structure:

```js
function renderWorktrees(wts) {
  el('wtCount').textContent = wts.length ? `${wts.length}` : '';
  el('wtChanges').disabled = wts.length === 0;
  el('worktrees').innerHTML = wts.length ? wts.map((w) => {
    const stats = worktreeStats[w.repo];
    const totals = stats
      ? `<span class="wstats"><span class="wadd">+${stats.additions}</span> <span class="wdel">−${stats.deletions}</span></span>`
      : '';
    const branch = w.branch
      ? `<span class="wbranch"><span class="wbr">${esc(w.branch)}</span>`
        + `<button class="ib t-copy" data-act="copy-worktree-branch" data-branch="${esc(w.branch)}" data-copy aria-label="Copy branch name" title="Copy branch name">${svgIcon('copy')}</button></span>`
      : '';
    return `<div class="wt"><span class="wrepo">${esc(w.repoDisplay || w.repo)}</span>`
      + branch + totals + `<span class="wacts">`
      + `<button data-act="open-worktree-terminal" data-path="${esc(w.path)}">Open Terminal</button>`
      + `<button data-act="open-worktree-folder" data-path="${esc(w.path)}">Reveal in Explorer</button>`
      + `</span></div>`;
  }).join('') : '<div class="empty">No worktrees.</div>';
}
```

In delegated click handling, send `dataset.branch` as `{ type: act, branch }` and keep `flashCopied(btn)` for `data-copy` buttons.

In the window message handler, add before the `state` case:

```js
if (msg.type === 'worktree-stats') {
  worktreeStats = Object.fromEntries((msg.stats || []).map((stats) => [stats.repo, stats]));
  if (lastState) renderWorktrees(lastState.worktrees || []);
  return;
}
```

Clear `worktreeStats = {};` when a new normal state arrives before `render(msg.state)`, so old totals never survive while a new Git request is loading.

- [ ] **Step 5: Run the webview test to verify GREEN**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`

Expected: PASS, including the existing guard that every literal `data-act` is declared in `messages.ts`.

- [ ] **Step 6: Commit the webview UI**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: improve dashboard worktree controls"
```

---

### Task 4: Testable VS Code Worktree Effects and Extension Wiring

**Files:**
- Create: `src/ui/dashboard/worktreeActions.ts`
- Create: `src/ui/dashboard/worktreeActions.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `DashboardActions` additions from Task 2, `loadWorktreeStats` from Task 1, `defaultGitRunner`, and VS Code terminal/clipboard/command APIs.
- Produces: `makeWorktreeActions(host, logError)` returning `Pick<DashboardActions, 'openWorktreeTerminal' | 'openWorktreeFolder' | 'copyWorktreeBranch'>`.

- [ ] **Step 1: Write failing effect-adapter tests**

Create `src/ui/dashboard/worktreeActions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { makeWorktreeActions, type WorktreeActionHost } from './worktreeActions.js';

const fakeHost = (): WorktreeActionHost => ({
  createTerminal: vi.fn(() => ({ show: vi.fn() })),
  revealInExplorer: vi.fn().mockResolvedValue(undefined),
  expandExplorer: vi.fn().mockResolvedValue(undefined),
  writeClipboard: vi.fn().mockResolvedValue(undefined),
});

describe('makeWorktreeActions', () => {
  it('creates and reveals a terminal rooted at the worktree', () => {
    const host = fakeHost();
    const terminal = { show: vi.fn() };
    vi.mocked(host.createTerminal).mockReturnValue(terminal);
    makeWorktreeActions(host, vi.fn()).openWorktreeTerminal('/wt/a');
    expect(host.createTerminal).toHaveBeenCalledWith({ name: 'Karst Worktree', cwd: '/wt/a' });
    expect(terminal.show).toHaveBeenCalledOnce();
  });

  it('reveals before expanding the Explorer node', async () => {
    const order: string[] = [];
    const host = fakeHost();
    vi.mocked(host.revealInExplorer).mockImplementation(async () => { order.push('reveal'); });
    vi.mocked(host.expandExplorer).mockImplementation(async () => { order.push('expand'); });
    makeWorktreeActions(host, vi.fn()).openWorktreeFolder('/wt/a');
    await vi.waitFor(() => expect(order).toEqual(['reveal', 'expand']));
  });

  it('copies the branch and reports rejected async effects', async () => {
    const error = new Error('clipboard unavailable');
    const host = fakeHost();
    const logError = vi.fn();
    vi.mocked(host.writeClipboard).mockRejectedValue(error);
    makeWorktreeActions(host, logError).copyWorktreeBranch('karst/A');
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
      'karst: dashboard worktree action failed', error,
    ));
  });
});
```

- [ ] **Step 2: Run the effect-adapter test to verify RED**

Run: `npx vitest run src/ui/dashboard/worktreeActions.test.ts`

Expected: FAIL because `./worktreeActions.js` does not exist.

- [ ] **Step 3: Implement the VS Code-free effect adapter**

Create `src/ui/dashboard/worktreeActions.ts`:

```ts
import type { LogError } from '../../logging/logger.js';
import type { DashboardActions } from './messages.js';

export interface WorktreeActionHost {
  createTerminal(options: { name: string; cwd: string }): { show(): void };
  revealInExplorer(path: string): Promise<unknown>;
  expandExplorer(): Promise<unknown>;
  writeClipboard(text: string): Promise<unknown>;
}

export function makeWorktreeActions(
  host: WorktreeActionHost,
  logError: LogError,
): Pick<DashboardActions, 'openWorktreeTerminal' | 'openWorktreeFolder' | 'copyWorktreeBranch'> {
  const contain = (effect: Promise<unknown>): void => {
    void effect.catch((error) => logError('karst: dashboard worktree action failed', error));
  };
  return {
    openWorktreeTerminal: (path) => {
      host.createTerminal({ name: 'Karst Worktree', cwd: path }).show();
    },
    openWorktreeFolder: (path) => {
      contain(host.revealInExplorer(path).then(() => host.expandExplorer()));
    },
    copyWorktreeBranch: (branch) => {
      contain(host.writeClipboard(branch));
    },
  };
}
```

- [ ] **Step 4: Run the adapter test to verify GREEN**

Run: `npx vitest run src/ui/dashboard/worktreeActions.test.ts`

Expected: PASS.

- [ ] **Step 5: Wire VS Code and the Git loader in `extension.ts`**

Import `makeWorktreeActions` and `loadWorktreeStats`. At the start of `makeDashboardActions`, build:

```ts
const worktreeActions = makeWorktreeActions(
  {
    createTerminal: (options) => vscode.window.createTerminal(options),
    revealInExplorer: (path) =>
      vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path)),
    expandExplorer: () => vscode.commands.executeCommand('list.expand'),
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
  },
  logError,
);
```

Replace the old inline `openWorktreeFolder` property with:

```ts
showChanges,
...worktreeActions,
```

Append the stats loader to the `new DashboardManager(...)` arguments after `binding`:

```ts
(worktrees) => loadWorktreeStats(worktrees, defaultGitRunner, logError),
```

- [ ] **Step 6: Run all focused dashboard tests**

Run: `npx vitest run src/ui/dashboard/worktreeStats.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/webview.test.ts src/ui/dashboard/worktreeActions.test.ts`

Expected: PASS.

- [ ] **Step 7: Run typecheck and fix only implementation defects**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 8: Commit extension wiring**

```bash
git add src/ui/dashboard/worktreeActions.ts src/ui/dashboard/worktreeActions.test.ts src/extension.ts
git commit -m "feat: wire dashboard worktree actions"
```

---

### Task 5: Full Verification, Review, and Ticket Advancement

**Files:**
- Review all files changed by Tasks 1–4.
- Do not edit generated `dist/` assets; `npm run build` owns those outputs.

**Interfaces:**
- Consumes: the complete dashboard worktree feature.
- Produces: verified commits and the Karst implementation-stage marker.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: PASS for the entire Vitest suite.

- [ ] **Step 2: Run static verification and build**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS, including copying the updated source webview asset into `dist/`.

- [ ] **Step 3: Inspect the final diff for accidental or generated edits**

Run: `git status --short`

Expected: only intended source/test changes, or a clean tree if every task commit is complete.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git diff HEAD~4 -- src/ui/dashboard src/extension.ts docs/superpowers`

Expected: changes match the approved design: stats semantics, accessible controls, sequenced Explorer expansion, branch copying, and no SQLite/dashboard-state mutation.

- [ ] **Step 4: Request and process code review**

Use `superpowers:requesting-code-review` against the implementation commits. For every finding, verify it against the code and tests using `superpowers:receiving-code-review`; fix confirmed issues with a new failing test first, then rerun the focused and full checks.

- [ ] **Step 5: Record the implementation marker**

Run exactly:

```bash
node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket 869eckhfz
```

Expected: the CLI records the done marker and advances ticket `869eckhfz` to its next stage.

## Self-Review

- Spec coverage: Task 1 covers approved Git semantics and failure isolation; Task 2 covers the trust boundary and stale-safe ephemeral delivery; Task 3 covers every requested visual/action change and copy feedback; Task 4 covers terminal, clipboard, reveal-then-expand behavior and live extension wiring; Task 5 covers full verification, review, and advancement.
- Type consistency: `WorktreeStats`, `WorktreeStatsLoader`, message discriminants, action names, and the final `DashboardManager` constructor argument are identical across producer and consumer tasks.
- Scope: no database schema, manifest, persisted dashboard state, generated asset, or existing ticket-changes behavior is changed.
