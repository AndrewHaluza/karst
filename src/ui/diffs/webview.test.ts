import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { injectDesignSystem } from '../../model/designSystem.js';
import type {
  ChangedFileView,
  CommitView,
  TicketChangesState,
  WorktreeChangesView,
} from './snapshot.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

/**
 * The REAL design-system runtime injected exactly as the host does, so
 * `karstAction`/`karstIsPending`/`karstBeginPending`/`karstSettle` in the
 * tests below are the same code the webview ships with, not a second
 * hand-rolled copy (STYLE-GUIDE §5.5, DESIGN-SYSTEM §5).
 */
const HYDRATED = injectDesignSystem(HTML);

/**
 * The webview's rendering and filtering are executed, not pattern-matched:
 * the page's whole inline script (with the design-system markers hydrated) is
 * lifted into a `node:vm` context with DOM and `acquireVsCodeApi` doubles, so
 * the real `esc`, the real filter predicates, the real row builders, AND the
 * real shared pending/settle runtime are the code under test. Only the
 * handful of contracts that cannot be executed (the CSP placeholder, the
 * absence of a second post shape) remain source-level guards against the raw
 * `HTML`.
 *
 * Host-side git inspection, target resolution, and message validation are
 * covered in panel.test.ts.
 */

function scriptSource(): string {
  const open = HYDRATED.indexOf('<script>');
  const close = HYDRATED.indexOf('</script>', open);
  if (open < 0 || close < 0) throw new Error('webview.html has no inline script');
  return HYDRATED.slice(open + '<script>'.length, close);
}

/** Raw (un-hydrated) `<style>` block — for text-level token/primitive guards. */
function styleBlock(): string {
  const start = HTML.indexOf('<style>');
  const end = HTML.indexOf('</style>');
  expect(start, '<style> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</style> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<style>'.length, end);
}

/** Raw (un-hydrated) `<script>` block — for text-level markup/wiring guards. */
function scriptBlock(): string {
  const start = HTML.indexOf('<script>');
  const end = HTML.indexOf('</script>');
  expect(start, '<script> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</script> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<script>'.length, end);
}

const EXPORTS = [
  'fileMatches',
  'commitMatches',
  'worktreeMatches',
  'fileRow',
  'pendingGroup',
  'commitRow',
  'worktreeRow',
  'filesList',
  'render',
  'esc',
  'includes',
  'STATUS',
] as const;

type Handler = (arg?: unknown) => void;

interface Listeners {
  addEventListener: (type: string, handler: Handler) => void;
  fire: (type: string, arg?: unknown) => void;
}

function listenable<T extends object>(base: T): T & Listeners {
  const handlers = new Map<string, Handler>();
  return {
    ...base,
    addEventListener: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
    fire: (type: string, arg?: unknown) => {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`no ${type} listener registered`);
      handler(arg);
    },
  };
}

interface Harness {
  fileMatches: (file: ChangedFileView, needle: string) => boolean;
  commitMatches: (commit: CommitView, needle: string) => boolean;
  worktreeMatches: (worktree: WorktreeChangesView, needle: string) => boolean;
  fileRow: (file: ChangedFileView) => string;
  pendingGroup: (label: string, files: ChangedFileView[], key?: string) => string;
  commitRow: (commit: CommitView, index: number) => string;
  worktreeRow: (worktree: WorktreeChangesView) => string;
  filesList: (files: ChangedFileView[], key: string) => string;
  render: (state: TicketChangesState | null, isLoading: boolean) => void;
  esc: (value: unknown) => string;
  status: Record<string, string>;
  summary: { textContent: string };
  refresh: { disabled: boolean; attrs: Record<string, string> } & Listeners;
  filterBox: { value: string } & Listeners;
  viewTree: { attrs: Record<string, string> } & Listeners;
  viewFlat: { attrs: Record<string, string> } & Listeners;
  repos: { innerHTML: string };
  notice: { textContent: string; hidden: boolean };
  posted: unknown[];
  saved: unknown[];
  filterBy: (value: string) => void;
  clickRefresh: () => void;
  clickView: (mode: 'tree' | 'flat') => void;
  toggleDir: (key: string, open: boolean) => void;
  clickRow: (changeId: string | null) => FileRowButtonDouble | null;
  /** Re-fires the delegated click handler on an EXISTING row double — for a repeat click on the same row. */
  clickButton: (button: FileRowButtonDouble) => void;
  clickCopy: (hash: string) => CopyButtonDouble;
  receive: (data: unknown) => void;
}

/** The one node the copy handler mutates, with only the API it touches. */
interface CopyButtonDouble {
  dataset: Record<string, string>;
  textContent: string;
  label: string;
  classes: string[];
  defaultPrevented: boolean;
}

function copyButton(hash: string): CopyButtonDouble & {
  classList: { add: (name: string) => void; remove: (name: string) => void };
  setAttribute: (name: string, value: string) => void;
  closest: (selector: string) => unknown;
} {
  const button = {
    dataset: { copyHash: hash } as Record<string, string>,
    textContent: '⧉',
    label: 'Copy commit hash',
    classes: [] as string[],
    defaultPrevented: false,
    classList: {
      add: (name: string) => { button.classes.push(name); },
      remove: (name: string) => { button.classes = button.classes.filter((n) => n !== name); },
    },
    setAttribute: (name: string, value: string) => {
      if (name === 'aria-label') button.label = value;
    },
    closest: (selector: string) => (selector === '[data-copy-hash]' ? button : null),
  };
  return button;
}

/**
 * The one node the delegated open-diff handler mutates. It has to behave
 * enough like a real element for the REAL `karstBeginPending`/`karstSettle`
 * (not a fake) to operate on it: attribute tracking plus a `classList`.
 */
interface FileRowButtonDouble {
  dataset: Record<string, string>;
  disabled: boolean;
  attrs: Record<string, string>;
  classes: string[];
  classList: { add: (name: string) => void; remove: (name: string) => void };
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  closest: (selector: string) => unknown;
}

function fileRowButton(changeId: string): FileRowButtonDouble {
  const button: FileRowButtonDouble = {
    dataset: { changeId },
    disabled: false,
    attrs: {},
    classes: [],
    classList: {
      add: (name: string) => { button.classes.push(name); },
      remove: (name: string) => { button.classes = button.classes.filter((n) => n !== name); },
    },
    setAttribute: (name: string, value: string) => { button.attrs[name] = value; },
    removeAttribute: (name: string) => { delete button.attrs[name]; },
    closest: (selector: string) => (selector === '[data-change-id]' ? button : null),
  };
  return button;
}

/** A minimal element double for whatever `document.createElement` mints (the toast node). */
function elementDouble(): Record<string, unknown> {
  const attrs: Record<string, string> = {};
  const classes: string[] = [];
  const el: Record<string, unknown> = {
    textContent: '',
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
    getAttribute: (name: string) => attrs[name],
    appendChild: () => {},
    classList: {
      add: (name: string) => { classes.push(name); },
      remove: (name: string) => {
        const i = classes.indexOf(name);
        if (i >= 0) classes.splice(i, 1);
      },
    },
  };
  return el;
}

function chipDouble(id: string): { id: string; attrs: Record<string, string> } & Listeners {
  const attrs: Record<string, string> = {};
  return listenable({
    id,
    attrs,
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
  });
}

function boot(restored?: { state?: unknown; loading?: boolean; viewMode?: unknown }): Harness {
  const posted: unknown[] = [];
  const saved: unknown[] = [];
  const summary = { textContent: '' };
  const repos = { innerHTML: '' };
  const notice = { textContent: '', hidden: false };
  const refreshAttrs: Record<string, string> = {};
  const refresh = listenable({
    disabled: false,
    attrs: refreshAttrs,
    setAttribute: (name: string, value: string) => { refreshAttrs[name] = value; },
    getAttribute: (name: string) => refreshAttrs[name],
  });
  const filterBox = listenable({ value: '' });
  const viewTree = chipDouble('viewTree');
  const viewFlat = chipDouble('viewFlat');
  const elements: Record<string, unknown> = {
    summary, repos, notice, refresh, filter: filterBox, viewTree, viewFlat,
  };
  // `karstToastRoot` (the REAL runtime) looks up 'k-toast-root' then mints it
  // via `createElement`/`body.appendChild` on a miss — both are needed for the
  // executed script not to throw when a request settles with `ok:false`.
  const documentDouble = listenable({
    getElementById: (id: string) => elements[id] ?? null,
    createElement: () => elementDouble(),
    body: { appendChild: () => {} },
  });
  const windowDouble = listenable({});

  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({
      getState: () => restored,
      setState: (value: unknown) => saved.push(value),
      postMessage: (value: unknown) => posted.push(value),
    }),
    document: documentDouble,
    window: windowDouble,
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  runInNewContext(
    `${scriptSource()}\n;globalThis.__karst = { ${EXPORTS.join(', ')} };`,
    sandbox,
  );
  const exported = sandbox.__karst as Record<string, unknown>;

  return {
    fileMatches: exported.fileMatches as Harness['fileMatches'],
    commitMatches: exported.commitMatches as Harness['commitMatches'],
    worktreeMatches: exported.worktreeMatches as Harness['worktreeMatches'],
    fileRow: exported.fileRow as Harness['fileRow'],
    pendingGroup: exported.pendingGroup as Harness['pendingGroup'],
    commitRow: exported.commitRow as Harness['commitRow'],
    worktreeRow: exported.worktreeRow as Harness['worktreeRow'],
    filesList: exported.filesList as Harness['filesList'],
    render: exported.render as Harness['render'],
    esc: exported.esc as Harness['esc'],
    status: exported.STATUS as Record<string, string>,
    summary,
    refresh: refresh as Harness['refresh'],
    filterBox,
    viewTree: viewTree as Harness['viewTree'],
    viewFlat: viewFlat as Harness['viewFlat'],
    repos,
    notice,
    posted,
    saved,
    filterBy: (value: string) => {
      filterBox.value = value;
      filterBox.fire('input');
    },
    clickRefresh: () => refresh.fire('click'),
    clickView: (mode: 'tree' | 'flat') => {
      (mode === 'tree' ? viewTree : viewFlat).fire('click');
    },
    toggleDir: (key: string, open: boolean) => {
      documentDouble.fire('toggle', { target: { dataset: { dir: key }, open } });
    },
    clickRow: (changeId: string | null) => {
      const button = changeId === null ? null : fileRowButton(changeId);
      documentDouble.fire('click', {
        target: {
          closest: (selector: string) => (selector === '[data-change-id]' && button ? button : null),
        },
      });
      return button;
    },
    clickButton: (button: FileRowButtonDouble) => {
      documentDouble.fire('click', {
        target: {
          closest: (selector: string) => (selector === '[data-change-id]' ? button : null),
        },
      });
    },
    clickCopy: (hash: string) => {
      const button = copyButton(hash);
      documentDouble.fire('click', {
        target: button,
        preventDefault: () => { button.defaultPrevented = true; },
      });
      return button;
    },
    receive: (data: unknown) => windowDouble.fire('message', { data }),
  };
}

function fileView(overrides: Partial<ChangedFileView> = {}): ChangedFileView {
  return { changeId: 'ch-1', status: 'modified', path: 'src/app.ts', oldPath: null, absolutePath: '/repo/src/app.ts', ...overrides };
}

function commitView(overrides: Partial<CommitView> = {}): CommitView {
  return {
    hash: '9f1c2ab7d5e04416b3ca9f8e77d0a1c5b6e34210',
    shortHash: '9f1c2ab',
    subject: 'Add gate runner',
    author: 'Ada Lovelace',
    authoredAt: '2026-07-30',
    files: [],
    ...overrides,
  };
}

function worktreeView(overrides: Partial<WorktreeChangesView> = {}): WorktreeChangesView {
  return {
    label: 'api',
    branch: 'karst/feat/gates',
    baseRef: 'origin/main',
    commits: [],
    staged: [],
    unstaged: [],
    untracked: [],
    error: null,
    ...overrides,
  };
}

function stateOf(
  worktrees: WorktreeChangesView[],
  counts: { commitCount: number; pendingCount: number },
): TicketChangesState {
  return {
    ticketId: 7,
    worktreeCount: worktrees.length,
    commitCount: counts.commitCount,
    pendingCount: counts.pendingCount,
    worktrees,
  };
}

describe('ticket changes webview escaping', () => {
  it('entity-encodes every git-controlled field of a file row', () => {
    const { fileRow } = boot();
    const html = fileRow(
      fileView({
        changeId: 'ch-1" onmouseover="steal()',
        path: "src/<script>alert('x')</script>.ts",
        oldPath: 'docs/a&b.ts',
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onmouseover="steal()"');
    expect(html).toContain('data-change-id="ch-1&quot; onmouseover=&quot;steal()"');
    expect(html).toContain('docs/a&amp;b.ts → src/&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;.ts');
  });

  it('entity-encodes a hostile status without letting it break the class attribute', () => {
    const { fileRow } = boot();
    const html = fileRow(fileView({ status: 'modified" data-x="' as ChangedFileView['status'] }));
    expect(html).toContain('class="status status-modified&quot; data-x=&quot;"');
    expect(html).not.toContain('data-x=""');
  });

  it('entity-encodes commit subject, author, hash, and date', () => {
    const { commitRow } = boot();
    const html = commitRow(
      commitView({
        shortHash: '<b>bad</b>',
        subject: '<script>alert("x")</script>',
        author: "O'Brien & \"co\"",
        authoredAt: '<time>',
      }),
      0,
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bad</b>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('O&#39;Brien &amp; &quot;co&quot;');
    expect(html).toContain('&lt;time&gt;');
  });

  it('entity-encodes worktree label, branch, and base ref', () => {
    const { worktreeRow } = boot();
    const html = worktreeRow(
      worktreeView({
        label: '<img src=x onerror=alert(1)>',
        branch: 'feat/"quoted"',
        baseRef: "origin/'main'",
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('feat/&quot;quoted&quot; ↔ origin/&#39;main&#39;');
  });

  it('entity-encodes a repository error message', () => {
    const { worktreeRow } = boot();
    const html = worktreeRow(
      worktreeView({
        label: 'web & api',
        error: "fatal: bad revision '<script>alert(1)</script>'",
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('<h2>web &amp; api</h2>');
    expect(html).toContain('fatal: bad revision &#39;&lt;script&gt;alert(1)&lt;/script&gt;&#39;');
  });

  it('entity-encodes a group label and renders nothing for an empty group', () => {
    const { pendingGroup } = boot();
    expect(pendingGroup('STAGED CHANGES', [])).toBe('');
    const html = pendingGroup('<b>STAGED</b>', [fileView(), fileView({ changeId: 'ch-2' })]);
    expect(html).not.toContain('<b>STAGED</b>');
    expect(html).toContain('&lt;b&gt;STAGED&lt;/b&gt;<span>2</span>');
  });
});

describe('ticket changes webview filtering', () => {
  it('matches a file on path or old path and excludes a non-match', () => {
    const { fileMatches } = boot();
    expect(fileMatches(fileView({ path: 'src/gates/run.ts' }), 'gates')).toBe(true);
    expect(fileMatches(fileView({ path: 'src/a.ts', oldPath: 'src/legacy.ts' }), 'legacy')).toBe(true);
    expect(fileMatches(fileView({ path: 'src/a.ts' }), 'legacy')).toBe(false);
    expect(fileMatches(fileView({ oldPath: null }), 'null')).toBe(false);
  });

  it('matches a commit on hash, short hash, subject, author, or a file it touches', () => {
    const { commitMatches } = boot();
    const commit = commitView({ files: [fileView({ path: 'src/workflow/machine.ts' })] });
    for (const needle of ['9f1c2ab7d5e04416', '9f1c2ab', 'gate runner', 'lovelace', 'machine.ts']) {
      expect(commitMatches(commit, needle)).toBe(true);
    }
    expect(commitMatches(commit, 'nothing-here')).toBe(false);
  });

  it('matches a worktree on label, branch, base ref, a commit, or a pending file', () => {
    const { worktreeMatches } = boot();
    const base = worktreeView({
      commits: [commitView({ subject: 'Wire ports' })],
      staged: [fileView({ path: 'src/staged.ts' })],
      unstaged: [fileView({ path: 'src/unstaged.ts' })],
      untracked: [fileView({ path: 'src/untracked.ts' })],
    });
    for (const needle of [
      'api',
      'karst/feat/gates',
      'origin/main',
      'wire ports',
      'staged.ts',
      'unstaged.ts',
      'untracked.ts',
    ]) {
      expect(worktreeMatches(base, needle)).toBe(true);
    }
    expect(worktreeMatches(base, 'zzz-absent')).toBe(false);
  });

  it('excludes a non-matching worktree from the rendered list', () => {
    const harness = boot();
    const worktrees = [
      worktreeView({ label: 'api', commits: [commitView({ subject: 'Wire ports' })] }),
      worktreeView({ label: 'web', branch: 'karst/feat/web', staged: [fileView({ path: 'ui/app.tsx' })] }),
    ];
    harness.render(stateOf(worktrees, { commitCount: 1, pendingCount: 1 }), false);
    expect(harness.repos.innerHTML).toContain('api');
    expect(harness.repos.innerHTML).toContain('web');

    harness.filterBy('app.tsx');
    expect(harness.repos.innerHTML).toContain('<strong>web</strong>');
    expect(harness.repos.innerHTML).not.toContain('<strong>api</strong>');
  });

  it('filters case-insensitively and ignores surrounding whitespace', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView({ label: 'API-Gateway' })], { commitCount: 0, pendingCount: 0 }), false);
    harness.filterBy('  API-GATE  ');
    expect(harness.repos.innerHTML).toContain('API-Gateway');
  });
});

describe('ticket changes webview rows', () => {
  it('opens only the first commit and counts its files', () => {
    const { commitRow } = boot();
    const commit = commitView({ files: [fileView(), fileView({ changeId: 'ch-2' })] });
    expect(commitRow(commit, 0)).toContain('<details class="commit" open>');
    expect(commitRow(commit, 1)).toContain('<details class="commit">');
    expect(commitRow(commit, 0)).toContain('<span>2</span></summary>');
  });

  /**
   * The hash and the subject are separate grid items — a literal space between
   * them printed as a second gap after the hash on top of the layout's own.
   */
  it('leaves no text node between the hash and the subject', () => {
    const { commitRow } = boot();
    expect(commitRow(commitView(), 0)).toContain('</code>Add gate runner');
  });

  it('offers the full hash to copy while showing the abbreviation', () => {
    const { commitRow } = boot();
    const html = commitRow(commitView(), 0);
    expect(html).toContain('<code data-hash>9f1c2ab</code>');
    expect(html).toContain(
      'data-copy-hash="9f1c2ab7d5e04416b3ca9f8e77d0a1c5b6e34210"',
    );
    expect(html).toContain('aria-label="Copy commit hash"');
  });

  it('opens a repository only when it has commits or pending files', () => {
    const { worktreeRow } = boot();
    expect(worktreeRow(worktreeView())).toContain('<details class="repo">');
    expect(worktreeRow(worktreeView())).toContain('0 commits · clean');
    expect(worktreeRow(worktreeView({ untracked: [fileView()] }))).toContain('<details class="repo" open>');
    expect(worktreeRow(worktreeView({ commits: [commitView()] }))).toContain('<details class="repo" open>');
  });

  it('summarises commit and pending counts across all three pending groups', () => {
    const { worktreeRow } = boot();
    const html = worktreeRow(
      worktreeView({
        commits: [commitView(), commitView({ shortHash: 'bbbbbbb' })],
        staged: [fileView()],
        unstaged: [fileView({ changeId: 'ch-2' }), fileView({ changeId: 'ch-3' })],
        untracked: [fileView({ changeId: 'ch-4' })],
      }),
    );
    expect(html).toContain('2 commits · 4 pending');
    expect(html).toContain('COMMITS<span>2</span>');
    expect(html).toContain('STAGED CHANGES<span>1</span>');
    expect(html).toContain('CHANGES<span>2</span>');
    expect(html).toContain('UNTRACKED FILES<span>1</span>');
  });

  it('renders an errored repository as an error section and nothing else', () => {
    const { worktreeRow } = boot();
    const html = worktreeRow(
      worktreeView({
        error: 'not a git repository',
        commits: [commitView()],
        staged: [fileView()],
      }),
    );
    expect(html).toContain('<section class="repo error">');
    expect(html).toContain('Refresh to try this repository again.');
    expect(html).not.toContain('COMMITS');
    expect(html).not.toContain('STAGED CHANGES');
    expect(html).not.toContain('data-change-id');
  });

  it('falls back to a detached branch and unknown base label', () => {
    const { worktreeRow } = boot();
    expect(worktreeRow(worktreeView({ branch: null, baseRef: null }))).toContain(
      '<small>detached ↔ unknown base</small>',
    );
  });

  it('maps known statuses and falls back to M for an unknown one', () => {
    const { fileRow } = boot();
    const glyph = (status: string): string => {
      const match = /<span class="status[^"]*"[^>]*>([^<]*)<\/span>/.exec(
        fileRow(fileView({ status: status as ChangedFileView['status'] })),
      );
      return match?.[1] ?? '';
    };
    expect(glyph('added')).toBe('A');
    expect(glyph('modified')).toBe('M');
    expect(glyph('deleted')).toBe('D');
    expect(glyph('renamed')).toBe('R');
    expect(glyph('copied')).toBe('M');
    expect(glyph('')).toBe('M');
  });

  /**
   * Colour is never the only carrier (UI-R28): the bare letter is decorative,
   * so the span is `role="img"` with the status spelled out in words as its
   * accessible name — the same shape as a `.k-dot`.
   */
  it('gives every status letter an accessible name in words, never colour alone', () => {
    const { fileRow } = boot();
    const label = (status: string): string | undefined => {
      const match = /<span class="status[^"]*" role="img" aria-label="([^"]*)">/.exec(
        fileRow(fileView({ status: status as ChangedFileView['status'] })),
      );
      return match?.[1];
    };
    expect(label('added')).toBe('Added');
    expect(label('modified')).toBe('Modified');
    expect(label('deleted')).toBe('Deleted');
    expect(label('renamed')).toBe('Renamed');
    expect(label('bogus')).toBe('Modified');
  });

  it('shows a rename as old → new and a plain path otherwise', () => {
    const { fileRow } = boot();
    expect(fileRow(fileView({ path: 'src/new.ts', oldPath: 'src/old.ts' }))).toContain(
      '<span class="file-path">src/old.ts → src/new.ts</span>',
    );
    expect(fileRow(fileView({ path: 'src/new.ts' }))).toContain(
      '<span class="file-path">src/new.ts</span>',
    );
  });
});

describe('ticket changes webview empty states', () => {
  it('shows the no-worktrees state when nothing has loaded', () => {
    const harness = boot();
    expect(harness.repos.innerHTML).toContain('No ticket worktrees. Create or attach worktrees, then refresh.');
    expect(harness.summary.textContent).toBe('No worktrees');
  });

  it('shows the loading state while a first refresh is in flight without changing the label (UI-R18)', () => {
    const harness = boot();
    harness.render(null, true);
    expect(harness.repos.innerHTML).toContain('Loading ticket worktrees…');
    expect(harness.refresh.disabled).toBe(true);
    expect(harness.refresh.attrs['aria-busy']).toBe('true');
  });

  it('shows the all-clean banner above the repository rows', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView(), worktreeView({ label: 'web' })], { commitCount: 0, pendingCount: 0 }), false);
    expect(harness.repos.innerHTML).toContain('All ticket worktrees are clean.');
    expect(harness.repos.innerHTML).toContain('<strong>api</strong>');
    expect(harness.summary.textContent).toBe('2 worktrees · 0 commits · 0 pending');
  });

  it('never calls a repository with an error clean', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView({ error: 'boom' })], { commitCount: 0, pendingCount: 0 }), false);
    expect(harness.repos.innerHTML).not.toContain('All ticket worktrees are clean.');
    expect(harness.repos.innerHTML).toContain('<section class="repo error">');
  });

  it('shows the no-match state when a filter excludes every repository', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 }), false);
    harness.filterBy('zzz-absent');
    expect(harness.repos.innerHTML).toBe(
      '<div class="empty">No changes match this filter. Clear the filter to see all repositories.</div>',
    );
  });

  it('prefers the no-match state over the loading state while filtering', () => {
    const harness = boot();
    harness.filterBox.value = 'zzz-absent';
    harness.render(stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 }), true);
    expect(harness.repos.innerHTML).toContain('No changes match this filter');
    expect(harness.repos.innerHTML).not.toContain('Loading ticket worktrees…');
  });
});

describe('ticket changes webview protocol', () => {
  /**
   * Opening a diff is a "handoff" async action (DESIGN-SYSTEM §5.1): a
   * requestId now rides along so the host's action-result can settle THIS
   * row specifically (UI-R11, UI-R13) — it carries no other payload.
   */
  it('posts an opaque change id and a requestId, and nothing else, when a file row is clicked', () => {
    const harness = boot();
    harness.clickRow('worktree-2:7');
    expect(harness.posted).toEqual([
      { type: 'open-diff', changeId: 'worktree-2:7', requestId: expect.any(String) },
    ]);
  });

  it('enters pending on the clicked row immediately, before any reply (UI-R11)', () => {
    const harness = boot();
    const button = harness.clickRow('worktree-2:7');
    expect(button?.disabled).toBe(true);
    expect(button?.attrs['aria-busy']).toBe('true');
  });

  it('drops a second click on the same row while it is pending, rather than posting again (UI-R12)', () => {
    const harness = boot();
    // Re-fire on the SAME row double both times: karstIsPending keys off
    // element identity, exactly as two clicks on the same un-re-rendered DOM
    // node would in the real webview.
    const button = harness.clickRow('worktree-2:7')!;
    harness.clickButton(button);
    expect(harness.posted).toHaveLength(1);
  });

  it('settles the row and leaves it re-clickable on a successful action-result (UI-R13)', () => {
    const harness = boot();
    const button = harness.clickRow('worktree-2:7');
    const requestId = (harness.posted[0] as { requestId: string }).requestId;
    harness.receive({ type: 'action-result', requestId, ok: true });
    expect(button?.disabled).toBe(false);
    expect(button?.attrs['aria-busy']).toBeUndefined();
  });

  it('settles the row on a failed action-result without leaving it stuck pending (UI-R13, UI-R14)', () => {
    const harness = boot();
    const button = harness.clickRow('worktree-2:7');
    const requestId = (harness.posted[0] as { requestId: string }).requestId;
    harness.receive({ type: 'action-result', requestId, ok: false, message: 'Diff unavailable' });
    expect(button?.disabled).toBe(false);
    expect(button?.attrs['aria-busy']).toBeUndefined();
  });

  it('posts nothing when the click misses a file row', () => {
    const harness = boot();
    harness.clickRow(null);
    expect(harness.posted).toEqual([]);
  });

  it('never posts a path, old path, or revision back to the host', () => {
    expect(HTML).not.toMatch(/postMessage\(\{[^}]*\b(?:path|oldPath|revision)\s*:/);
  });

  /**
   * A hash leaves the webview for exactly one reason — the clipboard request —
   * and the host re-validates it as a git object name before writing it. Any
   * second message shape carrying a hash would widen that surface.
   */
  it('posts a hash only as the clipboard request', () => {
    const posts = HTML.match(/postMessage\(\{[^}]*\bhash:[^}]*\}/g) ?? [];
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("type: 'copy-hash'");
  });

  it('posts the full hash and confirms the copy on the button itself, optimistically (UI-R15)', () => {
    const harness = boot();
    const button = harness.clickCopy('9f1c2ab7d5e04416b3ca9f8e77d0a1c5b6e34210');

    // No requestId: this is the one optimistic path (UI-R15), so it never
    // enters the karstAction pending/action-result lifecycle.
    expect(harness.posted).toEqual([
      { type: 'copy-hash', hash: '9f1c2ab7d5e04416b3ca9f8e77d0a1c5b6e34210' },
    ]);
    expect(button.defaultPrevented).toBe(true);
    expect(button.textContent).toBe('✓');
    expect(button.label).toBe('Copied');
    // Reuses the shared .is-success state class (designComponents.ts) rather
    // than a bespoke "copied" one, so it also gets --k-success for free.
    expect(button.classes).toContain('is-success');
  });

  it('renders the loading state immediately when refresh is clicked', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView({ commits: [commitView()] })], { commitCount: 1, pendingCount: 0 }), false);
    harness.clickRefresh();
    expect(harness.posted).toEqual([{ type: 'refresh' }]);
    expect(harness.refresh.disabled).toBe(true);
    expect(harness.repos.innerHTML).toContain('<strong>api</strong>');
  });

  it('keeps the prior snapshot visible while a refresh is loading', () => {
    const harness = boot();
    harness.receive({ type: 'state', state: stateOf([worktreeView({ commits: [commitView()] })], { commitCount: 1, pendingCount: 0 }) });
    harness.receive({ type: 'loading' });
    expect(harness.repos.innerHTML).toContain('<strong>api</strong>');
    expect(harness.repos.innerHTML).not.toContain('Loading ticket worktrees…');
    expect(harness.refresh.disabled).toBe(true);
  });

  it('shows a dismissable notice on error without discarding the last snapshot', () => {
    const harness = boot();
    harness.receive({ type: 'state', state: stateOf([worktreeView({ commits: [commitView()] })], { commitCount: 1, pendingCount: 0 }) });
    harness.receive({ type: 'error', message: 'git exited 128' });
    expect(harness.notice.hidden).toBe(false);
    expect(harness.notice.textContent).toBe(
      'Could not refresh ticket changes: git exited 128. Refresh to try again.',
    );
    expect(harness.repos.innerHTML).toContain('<strong>api</strong>');
    expect(harness.refresh.disabled).toBe(false);

    harness.receive({ type: 'state', state: stateOf([], { commitCount: 0, pendingCount: 0 }) });
    expect(harness.notice.hidden).toBe(true);
  });

  it('ignores malformed messages', () => {
    const harness = boot();
    expect(() => harness.receive(null)).not.toThrow();
    expect(() => harness.receive('state')).not.toThrow();
    expect(() => harness.receive({ type: 'unknown' })).not.toThrow();
    expect(harness.repos.innerHTML).toContain('No ticket worktrees.');
  });

  it('persists snapshot, loading flag, and view mode, and restores them on reload', () => {
    const harness = boot();
    const state = stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 });
    harness.receive({ type: 'loading', state });
    expect(harness.saved.at(-1)).toEqual({ state, loading: true, viewMode: 'tree' });

    harness.clickView('flat');
    expect(harness.saved.at(-1)).toEqual({ state, loading: true, viewMode: 'flat' });

    const reloaded = boot({ state, loading: true, viewMode: 'flat' });
    expect(reloaded.refresh.disabled).toBe(true);
    expect(reloaded.summary.textContent).toBe('1 worktrees · 0 commits · 0 pending');
    expect(reloaded.repos.innerHTML).toContain('<strong>api</strong>');
  });

  it('keeps the loading flag across a filter keystroke without re-querying the host', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 }), true);
    harness.filterBy('api');
    expect(harness.refresh.disabled).toBe(true);
    expect(harness.posted).toEqual([]);
  });

  it('carries the CSP placeholder the host substitutes at load', () => {
    expect(HTML).toContain('<!--KARST_CSP-->');
  });
});

/**
 * Text-level design-system conformance guards (Task 3.3 of the UI remediation
 * plan). These check the SOURCE (un-hydrated) markers and markup, same
 * rationale as every other `webview.test.ts` in this repo (STYLE-GUIDE §5).
 */
describe('ticket changes webview tree view', () => {
  it('defaults to tree mode: folders first, then files, nested directories expandable', () => {
    const harness = boot();
    const html = harness.pendingGroup('STAGED CHANGES', [
      fileView(),
      fileView({ changeId: 'ch-2', path: 'src/components/Button.tsx', status: 'added' }),
      fileView({ changeId: 'ch-3', path: 'package.json' }),
    ], 'staged');
    expect(html).toContain('<details class="dir" data-dir="staged:src" open>');
    expect(html).toContain('<details class="dir" data-dir="staged:src/components" open>');
    // Folders before files at every level: the src directory and its nested
    // components directory precede the file rows inside them.
    expect(html.indexOf('data-dir="staged:src"')).toBeLessThan(html.indexOf('data-change-id="ch-1"'));
    expect(html.indexOf('data-dir="staged:src/components"')).toBeLessThan(html.indexOf('data-change-id="ch-1"'));
    // The root-level file renders after the directory.
    expect(html.indexOf('data-change-id="ch-3"')).toBeGreaterThan(html.indexOf('data-change-id="ch-1"'));
  });

  it('shows the total file count on each directory row', () => {
    const html = boot().pendingGroup('STAGED CHANGES', [
      fileView(),
      fileView({ changeId: 'ch-2', path: 'src/components/Button.tsx' }),
    ], 'staged');
    expect(html).toContain('<span class="dir-name">src</span><span class="dir-count">2</span>');
    expect(html).toContain('<span class="dir-name">components</span><span class="dir-count">1</span>');
  });

  it('sorts sibling directories and files alphabetically', () => {
    const html = boot().pendingGroup('CHANGES', [
      fileView({ changeId: 'z', path: 'zeta.ts' }),
      fileView({ changeId: 'a', path: 'alpha/beta.ts' }),
      fileView({ changeId: 'b', path: 'alpha/gamma.ts' }),
    ], 'unstaged');
    expect(html.indexOf('data-change-id="a"')).toBeLessThan(html.indexOf('data-change-id="b"'));
    expect(html.indexOf('data-change-id="z"')).toBeGreaterThan(html.indexOf('data-change-id="b"'));
  });

  it('keys directory rows per group and per commit so expansion state cannot collide', () => {
    const staged = boot().pendingGroup('STAGED CHANGES', [fileView({ path: 'src/a.ts' })], 'staged');
    const unstaged = boot().pendingGroup('CHANGES', [fileView({ path: 'src/b.ts' })], 'unstaged');
    const commit = boot().commitRow(commitView({ files: [fileView({ path: 'src/c.ts' })] }), 0);
    expect(staged).toContain('data-dir="staged:src"');
    expect(unstaged).toContain('data-dir="unstaged:src"');
    expect(commit).toContain(`data-dir="commit:${commitView().hash}:src"`);
  });

  it('escapes a hostile directory name in the row and the collapse key', () => {
    const html = boot().pendingGroup('STAGED CHANGES', [fileView({ path: '<img src=x> /a.ts' })], 'staged');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt; </span>');
    expect(html).toContain('data-dir="staged:&lt;img src=x&gt; "');
  });

  it('renders a flat list with no directory rows when list mode is chosen', () => {
    const harness = boot();
    harness.clickView('flat');
    const html = harness.pendingGroup('STAGED CHANGES', [fileView({ path: 'src/app.ts' })], 'staged');
    expect(html).not.toContain('class="dir"');
    expect(html).toContain('<button type="button" class="k-btn k-btn--ghost k-btn--row file"');
  });

  it('toggles the view mode via the header chips, mirroring the mode in aria-pressed (UI-R26)', () => {
    const harness = boot();
    expect(harness.viewTree.attrs['aria-pressed']).toBe('true');
    expect(harness.viewFlat.attrs['aria-pressed']).toBe('false');
    harness.clickView('flat');
    expect(harness.viewTree.attrs['aria-pressed']).toBe('false');
    expect(harness.viewFlat.attrs['aria-pressed']).toBe('true');
    harness.clickView('tree');
    expect(harness.viewTree.attrs['aria-pressed']).toBe('true');
    expect(harness.viewFlat.attrs['aria-pressed']).toBe('false');
  });

  it('keeps a collapsed directory collapsed across a re-render and re-expands on demand', () => {
    const harness = boot();
    const state = () => stateOf(
      [worktreeView({ staged: [fileView({ path: 'src/app.ts' })] })],
      { commitCount: 0, pendingCount: 1 },
    );
    harness.render(state(), false);
    expect(harness.repos.innerHTML).toContain('<details class="dir" data-dir="staged:src" open>');
    harness.toggleDir('staged:src', false);
    harness.render(state(), false);
    expect(harness.repos.innerHTML).toContain('<details class="dir" data-dir="staged:src">');
    expect(harness.repos.innerHTML).not.toContain('<details class="dir" data-dir="staged:src" open>');
    harness.toggleDir('staged:src', true);
    harness.render(state(), false);
    expect(harness.repos.innerHTML).toContain('<details class="dir" data-dir="staged:src" open>');
  });

  it('forces the flat list while a filter is active, then returns to the chosen mode when cleared', () => {
    const harness = boot();
    harness.render(
      stateOf([worktreeView({ staged: [fileView({ path: 'src/app.ts' })] })], { commitCount: 0, pendingCount: 1 }),
      false,
    );
    expect(harness.repos.innerHTML).toContain('class="dir"');
    harness.filterBy('app.ts');
    expect(harness.repos.innerHTML).not.toContain('class="dir"');
    harness.filterBy('');
    expect(harness.repos.innerHTML).toContain('class="dir"');
  });

  it('restores a persisted list-mode choice on reload', () => {
    const harness = boot({
      state: stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 }),
      loading: false,
      viewMode: 'flat',
    });
    expect(harness.viewTree.attrs['aria-pressed']).toBe('false');
    expect(harness.viewFlat.attrs['aria-pressed']).toBe('true');
    const html = harness.pendingGroup('CHANGES', [fileView({ path: 'src/app.ts' })], 'unstaged');
    expect(html).not.toContain('class="dir"');
  });
});

describe('diffs webview design-system conformance', () => {
  it('carries the design-system markers ahead of any file-local rule (UI-R03)', () => {
    const style = styleBlock();
    expect(style.trimStart().startsWith('/*KARST_DS_CSS*/')).toBe(true);
    const script = scriptBlock();
    expect(script.trimStart().startsWith('/*KARST_DS_JS*/')).toBe(true);
    expect(HTML).toContain('<!--KARST_CSP-->');
  });

  it('declares no local :root block — tokens come from the injected design system (UI-R04, UI-R05)', () => {
    expect(styleBlock()).not.toContain(':root');
  });

  it('contains no raw hex/rgb/px/rem style literal outside the injected tokens, except the one unavoidable media breakpoint (UI-R04)', () => {
    const style = styleBlock();
    const local = style.slice(style.indexOf('/*KARST_DS_CSS*/') + '/*KARST_DS_CSS*/'.length);
    // Comments are prose (they quote the exact numbers being replaced, for
    // the next reader), not style values — strip them before scanning.
    const withoutComments = local.replace(/\/\*[\s\S]*?\*\//g, '');
    // @media conditions cannot read a custom property at all — the 440px
    // breakpoint therefore has no token-based alternative. Only the
    // CONDITION is excluded from the scan, not the ruleset it guards.
    const withoutMediaConditions = withoutComments.replace(/@media\s*\([^)]*\)/g, '@media(...)');
    const offenders = withoutMediaConditions.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b[0-9]+(\.[0-9]+)?(px|rem)\b/g);
    expect(offenders, JSON.stringify(offenders)).toBeNull();
  });

  it('does not restyle .file or .copy-hash with a local background/border/padding/border-radius rule (UI-R07)', () => {
    // The old defect: .file was a <button> zeroed out with border:0;
    // border-radius:0; background:none; text-align:left until it was
    // unrecognizable as a control, and .copy-hash carried its own bespoke
    // background/border/radius/font-size. Both now get their appearance
    // entirely from a k- primitive; only grid placement stays local.
    const style = styleBlock();
    for (const selector of ['.file', '.copy-hash']) {
      const rule = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(style);
      expect(rule, `${selector} rule not found`).not.toBeNull();
      const body = rule![1]!;
      expect(body, body).not.toMatch(/\bbackground\s*:/);
      expect(body, body).not.toMatch(/\bborder(-\w+)?\s*:/);
      expect(body, body).not.toMatch(/\bpadding\s*:/);
      expect(body, body).not.toMatch(/\bborder-radius\s*:/);
      expect(body, body).not.toMatch(/\bfont-size\s*:/);
    }
  });

  it('gives .file the k-btn ghost primitive and .copy-hash the k-iconbtn primitive', () => {
    const script = scriptBlock();
    expect(script).toContain('class="k-btn k-btn--ghost k-btn--row file"');
    expect(script).toContain('class="k-iconbtn copy-hash"');
  });

  /**
   * The success flash on a file row used to be the button-shaped one: a check
   * glyph auto-placed into the row's two-column grid — which put it on a second
   * line, immediately after the status letter, so a modified file read "M ✓" —
   * inside a --k-success border. The row variant makes the flash the row's own
   * highlight instead (UI-R13 still requires the outcome to be visible).
   */
  it('flashes a clicked file row as a highlight, never a check badge beside its status letter', () => {
    // The status letter is the row's only glyph, and it stays.
    const { fileRow } = boot();
    const row = fileRow(fileView({ status: 'modified' }));
    expect(row).toContain('>M</span>');
    expect(row).not.toContain('✓');
  });

  it('every <button> in the file carries a k-btn, k-iconbtn, or k-chip primitive (UI-R07)', () => {
    const classAttrs = [...HTML.matchAll(/<button\b[^>]*class="([^"]*)"[^>]*>/g)].map((m) => m[1]!);
    expect(classAttrs.length).toBeGreaterThan(0);
    for (const cls of classAttrs) {
      expect(cls, cls).toMatch(/\bk-btn\b|\bk-iconbtn\b|\bk-chip\b/);
    }
  });

  it('every k-btn carries a real variant', () => {
    const classAttrs = [...HTML.matchAll(/<button\b[^>]*class="([^"]*)"[^>]*>/g)].map((m) => m[1]!);
    const kBtns = classAttrs.filter((cls) => /\bk-btn\b/.test(cls));
    expect(kBtns.length).toBeGreaterThan(0);
    for (const cls of kBtns) {
      expect(cls, cls).toMatch(/k-btn--(primary|secondary|ghost|danger|link)/);
    }
  });

  it('uses a real, explicitly-hidden chevron element instead of decorative ::before content', () => {
    // A `content:` character on ::before has no way to carry aria-hidden and
    // can be read aloud by some screen readers. The chevron is DOM now.
    const style = styleBlock();
    expect(style).not.toMatch(/summary::before/);
    const script = scriptBlock();
    expect(script).toContain('<span class="chev" aria-hidden="true">');
  });

  it('handles action-result by settling the pending control (UI-R13)', () => {
    const script = scriptBlock();
    expect(script).toContain("msg.type === 'action-result'");
    expect(script).toContain('karstSettle(msg.requestId, msg.ok, msg.message)');
  });

  it('routes the delegated open-diff click through the shared pending mechanics, dropping a re-click (UI-R11, UI-R12)', () => {
    const script = scriptBlock();
    expect(script).toContain('karstIsPending(row)');
    expect(script).toContain('karstBeginPending(row, requestId)');
    expect(script).toMatch(/vscode\.postMessage\(\{\s*type:\s*'open-diff',\s*changeId:\s*row\.dataset\.changeId,\s*requestId\s*\}\)/);
  });

  it('documents the copy-hash flash as optimistic and why (UI-R15)', () => {
    const script = scriptBlock();
    expect(script).toMatch(/Optimistic \(UI-R15\)/);
    // Never a requestId on this post — that is what keeps it out of the
    // karstAction pending/action-result lifecycle and genuinely optimistic.
    expect(script).toContain("vscode.postMessage({ type: 'copy-hash', hash: copy.dataset.copyHash });");
  });

  it('never changes the refresh button label while pending (UI-R18)', () => {
    const script = scriptBlock();
    expect(script).not.toContain('refresh.textContent =');
    expect(script).toContain("refresh.setAttribute('aria-busy', loading ? 'true' : 'false')");
  });

  it('every icon-only control carries a matching title/aria-label pair (UI-R19, UI-R21, UI-R24)', () => {
    const script = scriptBlock();
    expect(script).toContain('aria-label="Copy commit hash" title="Copy commit hash"');
  });

  it('colours the change markers with the GitHub default palette (A green, D red, M amber, R gray)', () => {
    const style = styleBlock();
    expect(style).toContain('.status-added { color: var(--k-success); }');
    expect(style).toContain('.status-deleted { color: var(--k-danger); }');
    expect(style).toContain('.status-modified { color: var(--k-warning); }');
    expect(style).toContain('.status-renamed { color: var(--k-pending); }');
  });

  it('every title attribute is non-empty, period-free, and no longer than 80 characters (UI-R20)', () => {
    const titles = [...HTML.matchAll(/title="([^"]*)"/g)].map((m) => m[1]!);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title.length, title).toBeGreaterThan(0);
      expect(title.length, title).toBeLessThanOrEqual(80);
      expect(title.endsWith('.'), title).toBe(false);
    }
  });

  it('every static and JS-created button/input carries no forbidden pointer-events:none disable (UI-R17)', () => {
    expect(styleBlock()).not.toMatch(/pointer-events\s*:\s*none/);
  });
});
