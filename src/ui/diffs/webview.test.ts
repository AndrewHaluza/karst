import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { injectDesignSystem } from '../../model/designSystem.js';
import { diffsRenderFixtures } from './renderFixtures.js';
import { diffsSummaryText, worktreeCountText, type ChangedFileView, type CommitView, type TicketChangesState, type WorktreeChangesView } from './snapshot.js';

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

/** Which part of the tree a file row came from, as the host names it (DF-4). */
type FileGroup = 'commit' | 'staged' | 'unstaged' | 'untracked';
type ActionKind = 'open-file' | 'discard' | 'unstage';

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
  fileRow: (file: ChangedFileView, group?: FileGroup, display?: 'tree' | 'list') => string;
  pendingGroup: (label: string, files: ChangedFileView[], key?: string, group?: FileGroup) => string;
  commitRow: (commit: CommitView, index: number) => string;
  worktreeRow: (worktree: WorktreeChangesView) => string;
  filesList: (files: ChangedFileView[], key: string, group?: FileGroup) => string;
  render: (state: TicketChangesState | null, isLoading: boolean) => void;
  esc: (value: unknown) => string;
  status: Record<string, string>;
  summary: { textContent: string };
  ticketLabel: { textContent: string };
  refresh: { disabled: boolean; attrs: Record<string, string> } & Listeners;
  filterBox: { value: string } & Listeners;
  viewTree: { attrs: Record<string, string>; classes: string[] } & Listeners;
  viewFlat: { attrs: Record<string, string>; classes: string[] } & Listeners;
  repos: { innerHTML: string };
  notice: { textContent: string; hidden: boolean };
  filterCount: { textContent: string };
  posted: unknown[];
  saved: unknown[];
  filterBy: (value: string) => void;
  clickRefresh: () => void;
  clickView: (mode: 'tree' | 'flat') => void;
  toggleDir: (key: string, open: boolean) => void;
  /** A `toggle` event on a disclosure keyed by its `data-key` (DF-8). */
  toggleKey: (key: string, open: boolean) => void;
  /** Focuses the `details` whose `data-key` matches, through its summary. */
  focusKey: (key: string) => void;
  /** Focuses the file row whose `data-change-id` matches. */
  focusChange: (changeId: string) => void;
  activeKey: () => string | null;
  activeChangeId: () => string | null;
  /** Fires a keydown on the currently focused row. */
  press: (key: string) => void;
  /** Clicks any generated `data-*` button (show-all, open-ticket, refresh). */
  clickData: (attr: string, value?: string) => FileRowButtonDouble;
  clickRow: (changeId: string | null) => FileRowButtonDouble | null;
  /** Re-fires the delegated click handler on an EXISTING row double — for a repeat click on the same row. */
  clickButton: (button: FileRowButtonDouble) => void;
  /** Clicks one row action button (open-file, discard, unstage) through the delegated handler. */
  clickAction: (kind: ActionKind, changeId: string) => FileRowButtonDouble;
  /** Re-fires the delegated handler on an EXISTING action-button double. */
  fireAction: (button: FileRowButtonDouble) => void;
  clickCopy: (hash: string) => CopyButtonDouble;
  receive: (data: unknown) => void;
}

/** The one node the copy handler mutates, with only the API it touches. */
interface CopyButtonDouble {
  dataset: Record<string, string>;
  textContent: string;
  innerHTML: string;
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
    textContent: '',
    innerHTML: '',
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

/** The data-* key a row action carries, camel-cased the way `element.dataset` exposes it. */
function actionDatasetKey(kind: ActionKind): string {
  return kind.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * The one row-action button the delegated handler mutates. `closest` answers
 * only for its own `[data-*]` selector, so the handler walks the same chain the
 * real event target would.
 */
function actionRowButton(kind: ActionKind, changeId: string): FileRowButtonDouble {
  const attr = `[data-${kind}]`;
  const button = fileRowButton(changeId);
  button.dataset = { [actionDatasetKey(kind)]: changeId };
  button.closest = (selector: string) => (selector === attr ? button : null);
  return button;
}

/** A delegated click on one row action (or a re-fire on an existing double). */
function fireActionClick(documentDouble: Listeners, button: FileRowButtonDouble): void {
  documentDouble.fire('click', {
    target: { closest: (selector: string) => button.closest(selector), preventDefault: () => {} },
    preventDefault: () => {},
  });
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
    removeChild: () => {},
    addEventListener: () => {},
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

function chipDouble(id: string): {
  id: string;
  attrs: Record<string, string>;
  classes: string[];
  classList: { add: (name: string) => void; remove: (name: string) => void; toggle: (name: string, on?: boolean) => void };
  insertAdjacentHTML: () => void;
} & Listeners {
  const attrs: Record<string, string> = {};
  const classes: string[] = [];
  const toggle = (name: string, on?: boolean): void => {
    const has = classes.includes(name);
    const next = on === undefined ? !has : on;
    if (next && !has) classes.push(name);
    if (!next && has) classes.splice(classes.indexOf(name), 1);
  };
  return listenable({
    id,
    attrs,
    classes,
    classList: {
      add: (name: string) => toggle(name, true),
      remove: (name: string) => toggle(name, false),
      toggle,
    },
    insertAdjacentHTML: () => {},
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
  });
}

/**
 * The focusable rows of the tree, exactly as the page's roving tabindex sees
 * them: every disclosure summary plus every file row button.
 */
const FOCUS_SELECTOR = '#repos summary, #repos .file';

/**
 * A parsed node from the generated innerHTML. Only the parts the executed
 * script touches exist: attributes/dataset, classes, the open flag, focus and
 * the closest/querySelector walks used for focus return and key handling.
 */
interface FakeNode {
  tagName: string;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  classes: string[];
  open: boolean;
  parent: FakeNode | null;
  children: FakeNode[];
  tabIndex?: string;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | undefined;
  focus: () => void;
  closest: (selector: string) => FakeNode | null;
  querySelector: (selector: string) => FakeNode | null;
  querySelectorAll: (selector: string) => FakeNode[];
}

const CAMEL_ATTR = /-([a-z])/g;
const camelAttr = (name: string): string => name.replace(CAMEL_ATTR, (_all, letter: string) => letter.toUpperCase());

/** Supports the subset of selectors the webview uses: tag, .class, [data-*], and comma lists. */
function matchesSelector(node: FakeNode, selector: string): boolean {
  return selector.split(',').some((raw) => {
    const part = raw.trim().replace(/^#repos\s+/, '');
    if (!part) return false;
    const tag = /^([a-z][a-z0-9]*)/i.exec(part)?.[1]?.toUpperCase();
    if (tag && node.tagName !== tag) return false;
    for (const attr of part.matchAll(/\[data-([a-z0-9-]+)(?:="[^"]*")?\]/g)) {
      if (!(camelAttr(attr[1]!) in node.dataset)) return false;
    }
    for (const cls of part.matchAll(/\.([a-z0-9-]+)/gi)) {
      if (!node.classes.includes(cls[1]!)) return false;
    }
    return true;
  });
}

const VOID_TAGS = new Set(['INPUT', 'BR', 'IMG', 'META', 'HR', 'LINK']);
const HTML_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

function makeNode(
  tagName: string,
  attrs: Record<string, string>,
  parent: FakeNode | null,
  onFocus: (node: FakeNode) => void,
): FakeNode {
  const node: FakeNode = {
    tagName,
    attrs,
    dataset: {},
    classes: (attrs.class ?? '').split(/\s+/).filter(Boolean),
    open: 'open' in attrs,
    parent,
    children: [],
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
      if (name === 'tabindex') node.tabIndex = value;
      if (name === 'open') node.open = true;
    },
    getAttribute: (name: string) => attrs[name],
    focus: () => onFocus(node),
    closest: (selector: string) => {
      let current: FakeNode | null = node;
      while (current) {
        if (matchesSelector(current, selector)) return current;
        current = current.parent;
      }
      return null;
    },
    querySelector: (selector: string) => node.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: (selector: string) =>
      node.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]).filter((child) => matchesSelector(child, selector)),
  };
  for (const [name, value] of Object.entries(attrs)) {
    const data = /^data-([a-z0-9-]+)$/.exec(name);
    if (data) node.dataset[camelAttr(data[1]!)] = value;
  }
  return node;
}

/** Parses the generated innerHTML into nodes in document order. */
function parseNodes(html: string, onFocus: (node: FakeNode) => void): FakeNode[] {
  const root = makeNode('ROOT', {}, null, onFocus);
  const stack: FakeNode[] = [root];
  const all: FakeNode[] = [];
  for (const match of html.matchAll(HTML_TAG)) {
    const tagName = match[2]!.toUpperCase();
    if (match[1] === '/') {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]!.tagName === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of match[3]!.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
      attrs[attr[1]!] = attr[2] ?? '';
    }
    const parent = stack[stack.length - 1]!;
    const node = makeNode(tagName, attrs, parent, onFocus);
    parent.children.push(node);
    all.push(node);
    if (!VOID_TAGS.has(tagName) && !attrs['/']) stack.push(node);
  }
  return all;
}

function boot(restored?: {
  state?: unknown;
  loading?: boolean;
  viewMode?: unknown;
  karstPanel?: { ticketId: number };
  openState?: Record<string, boolean>;
}): Harness {
  const posted: unknown[] = [];
  const saved: unknown[] = [];
  const summary = { textContent: '' };
  const ticketLabel = { textContent: '' };
  const notice = { textContent: '', hidden: false };
  const filterCount = { textContent: '' };
  const refreshAttrs: Record<string, string> = {};
  const refresh = listenable({
    disabled: false,
    attrs: refreshAttrs,
    setAttribute: (name: string, value: string) => { refreshAttrs[name] = value; },
    getAttribute: (name: string) => refreshAttrs[name],
    insertAdjacentHTML: () => {},
  });
  const filterBox = listenable({ value: '' });
  const viewTree = chipDouble('viewTree');
  const viewFlat = chipDouble('viewFlat');

  // Timers are FIFO, not immediate: the 150 ms filter debounce must not run on
  // the keystroke itself, and the copy flash (1200 ms) must not settle early.
  // `flush` runs the short timers, which is what a settled keystroke does.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  const flush = (maxMs = 200): void => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms <= maxMs) {
        timers.delete(id);
        timer.fn();
      }
    }
  };

  const activeElement: { current: FakeNode | { tagName: string } } = { current: { tagName: 'BODY' } };
  let repos: {
    readonly innerHTML: string;
    querySelectorAll: (selector: string) => FakeNode[];
    querySelector: (selector: string) => FakeNode | null;
  };
  interface DocumentDouble extends Listeners {
    activeElement: FakeNode | { tagName: string };
    getElementById: (id: string) => unknown;
    createElement: () => unknown;
    body: { appendChild: () => void };
  }
  let documentDouble: DocumentDouble;
  const focusNode = (node: FakeNode): void => {
    activeElement.current = node;
    documentDouble.fire('focusin', { target: node });
  };
  let nodes: FakeNode[] = [];
  const reposDouble = {
    get innerHTML() {
      return reposHtml;
    },
    set innerHTML(value: string) {
      reposHtml = value;
      nodes = parseNodes(value, focusNode);
      activeElement.current = { tagName: 'BODY' };
    },
    querySelectorAll: (selector: string) => nodes.filter((node) => matchesSelector(node, selector)),
    querySelector: (selector: string) => nodes.find((node) => matchesSelector(node, selector)) ?? null,
  };
  let reposHtml = '';
  repos = reposDouble;

  const elements: Record<string, unknown> = {
    summary, ticketLabel, repos, notice, refresh, filter: filterBox, viewTree, viewFlat, filterCount,
  };
  // `karstToastRoot` (the REAL runtime) looks up 'k-toast-root' then mints it
  // via `createElement`/`body.appendChild` on a miss — both are needed for the
  // executed script not to throw when a request settles with `ok:false`.
  documentDouble = listenable({
    getElementById: (id: string) => elements[id] ?? null,
    createElement: () => elementDouble(),
    body: { appendChild: () => {} },
  }) as unknown as DocumentDouble;
  Object.defineProperty(documentDouble, 'activeElement', { get: () => activeElement.current });
  const windowDouble = listenable({});

  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({
      getState: () => restored,
      setState: (value: unknown) => saved.push(value),
      postMessage: (value: unknown) => posted.push(value),
    }),
    document: documentDouble,
    window: windowDouble,
    setTimeout: (fn: () => void, ms: number) => {
      timerId += 1;
      timers.set(timerId, { fn, ms });
      return timerId;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
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
    ticketLabel,
    refresh: refresh as Harness['refresh'],
    filterBox,
    viewTree: viewTree as Harness['viewTree'],
    viewFlat: viewFlat as Harness['viewFlat'],
    repos,
    notice,
    filterCount,
    posted,
    saved,
    filterBy: (value: string) => {
      filterBox.value = value;
      filterBox.fire('input');
      // A settled keystroke: the 150 ms debounce fires, the 1200 ms flash does not.
      flush();
    },
    clickRefresh: () => refresh.fire('click'),
    clickView: (mode: 'tree' | 'flat') => {
      (mode === 'tree' ? viewTree : viewFlat).fire('click');
    },
    toggleDir: (key: string, open: boolean) => {
      documentDouble.fire('toggle', { target: { dataset: { dir: key }, open } });
    },
    toggleKey: (key: string, open: boolean) => {
      documentDouble.fire('toggle', { target: { dataset: { key }, open } });
    },
    focusKey: (key: string) => {
      const details = repos.querySelectorAll('[data-key]').find((node) => node.dataset.key === key);
      if (!details) throw new Error(`no [data-key="${key}"] in the rendered tree`);
      const target = details.tagName === 'DETAILS' ? details.querySelector('summary') : details;
      if (!target) throw new Error(`[data-key="${key}"] has no summary`);
      target.focus();
    },
    focusChange: (changeId: string) => {
      const target = repos.querySelectorAll(FOCUS_SELECTOR).find((node) => node.dataset.changeId === changeId);
      if (!target) throw new Error(`no file row for "${changeId}"`);
      target.focus();
    },
    activeKey: () => {
      const el = activeElement.current as FakeNode;
      return el.closest?.('[data-key]')?.dataset.key ?? null;
    },
    activeChangeId: () => {
      const el = activeElement.current as FakeNode;
      return el.closest?.('[data-change-id]')?.dataset.changeId ?? null;
    },
    press: (key: string) => {
      documentDouble.fire('keydown', { key, target: activeElement.current, preventDefault: () => {} });
    },
    clickData: (attr: string, value = '') => {
      const selector = `[data-${attr}]`;
      const button = fileRowButton(value);
      button.dataset = { [camelAttr(attr)]: value };
      button.closest = (candidate: string) => (candidate === selector ? button : null);
      documentDouble.fire('click', { target: button, preventDefault: () => {} });
      return button;
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
    clickAction: (kind: ActionKind, changeId: string) => {
      const button = actionRowButton(kind, changeId);
      fireActionClick(documentDouble, button);
      return button;
    },
    fireAction: (button: FileRowButtonDouble) => fireActionClick(documentDouble, button),
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
    authoredLabel: 'Jul 30, 2026',
    files: [],
    ...overrides,
  };
}

function worktreeView(overrides: Partial<WorktreeChangesView> = {}): WorktreeChangesView {
  const base = {
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
  const pending = base.staged.length + base.unstaged.length + base.untracked.length;
  return { ...base, countText: worktreeCountText(base.commits.length, pending) };
}

function stateOf(
  worktrees: WorktreeChangesView[],
  counts: { commitCount: number; pendingCount: number },
): TicketChangesState {
  return {
    ticketId: 7,
    ticketLabel: 'T7 · Fix login',
    worktreeCount: worktrees.length,
    commitCount: counts.commitCount,
    pendingCount: counts.pendingCount,
    worktrees,
    summaryText: diffsSummaryText(worktrees.length, counts.commitCount, counts.pendingCount),
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
    // A rename is two lines (DF-6): the leaf names in tree mode; the full
    // hostile path still rides on the row title, fully escaped.
    expect(html).toContain('<span class="file-old">a&amp;b.ts</span>');
    expect(html).toContain('<span class="file-new">→ script&gt;.ts</span>');
    expect(html).toContain(
      'title="docs/a&amp;b.ts → src/&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;.ts"',
    );
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
    expect(html).toContain('feat/&quot;quoted&quot; · base origin/&#39;main&#39;');
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
    expect(html).toContain('web &amp; api');
    expect(html).toContain('fatal: bad revision &#39;&lt;script&gt;alert(1)&lt;/script&gt;&#39;');
    expect(html).not.toContain('<h2>');
  });

  it('entity-encodes a group label and renders nothing for an empty group', () => {
    const { pendingGroup } = boot();
    expect(pendingGroup('STAGED CHANGES', [])).toBe('');
    const html = pendingGroup('<b>STAGED</b>', [fileView(), fileView({ changeId: 'ch-2' })]);
    expect(html).not.toContain('<b>STAGED</b>');
    expect(html).toContain('&lt;b&gt;STAGED&lt;/b&gt;<span title="Files: 2" aria-label="Files: 2">2</span>');
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
  const HASH = '9f1c2ab7d5e04416b3ca9f8e77d0a1c5b6e34210';

  it('opens only the first commit and counts its files', () => {
    const { commitRow } = boot();
    const commit = commitView({ files: [fileView(), fileView({ changeId: 'ch-2' })] });
    expect(commitRow(commit, 0)).toContain(`<details class="commit" data-key="commit:${HASH}" open>`);
    expect(commitRow(commit, 1)).toContain(`<details class="commit" data-key="commit:${HASH}">`);
    expect(commitRow(commit, 0)).toContain('<span title="Files: 2" aria-label="Files: 2">2</span></summary>');
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
    expect(worktreeRow(worktreeView())).toContain('<details class="repo" data-key="repo:api">');
    expect(worktreeRow(worktreeView())).toContain('0 commits · clean');
    expect(worktreeRow(worktreeView({ untracked: [fileView()] }))).toContain('<details class="repo" data-key="repo:api" open>');
    expect(worktreeRow(worktreeView({ commits: [commitView()] }))).toContain('<details class="repo" data-key="repo:api" open>');
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
    expect(html).toContain('Commits<span title="Files: 2" aria-label="Files: 2">2</span>');
    expect(html).toContain('Staged changes<span title="Files: 1" aria-label="Files: 1">1</span>');
    expect(html).toContain('Changes<span title="Files: 2" aria-label="Files: 2">2</span>');
    expect(html).toContain('Untracked files<span title="Files: 1" aria-label="Files: 1">1</span>');
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
    expect(html).toContain('Could not read this worktree.');
    expect(html).toContain('data-refresh');
    expect(html).not.toContain('Commits<span');
    expect(html).not.toContain('Staged changes<span');
    expect(html).not.toContain('data-change-id');
  });

  it('falls back to a detached branch and unknown base label', () => {
    const { worktreeRow } = boot();
    expect(worktreeRow(worktreeView({ branch: null, baseRef: null }))).toContain(
      '<small>detached · base unknown base</small>',
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

  it('shows a rename as two lines, old then → new, and a plain path otherwise', () => {
    const { fileRow } = boot();
    const rename = fileRow(fileView({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }));
    expect(rename).toContain('<span class="file-path file-path--rename">');
    expect(rename).toContain('<span class="file-old">old.ts</span>');
    expect(rename).toContain('<span class="file-new">→ new.ts</span>');
    expect(fileRow(fileView({ path: 'src/new.ts' }))).toContain(
      '<span class="file-path">new.ts</span>',
    );
  });

  /**
   * DF-6: tree mode shows the leaf only, with the full path kept in `title`
   * and in the accessible name; list mode dims the directory part.
   */
  it('shows the leaf in tree mode and keeps the full path in title and accessible name', () => {
    const html = boot().fileRow(fileView({ path: 'src/components/Button.tsx' }), 'unstaged', 'tree');
    expect(html).toContain('<span class="file-path">Button.tsx</span>');
    expect(html).toContain('title="src/components/Button.tsx"');
    expect(html).toContain('<span class="sr">Full path: src/components/Button.tsx</span>');
  });

  it('dims the directory part in list mode and keeps the file name in full text', () => {
    const html = boot().fileRow(fileView({ path: 'src/components/Button.tsx' }), 'unstaged', 'list');
    expect(html).toContain(
      '<span class="file-path"><span class="file-dir">src/components/</span>Button.tsx</span>',
    );
    expect(html).not.toContain('<span class="sr">Full path:');
  });

  /** DF-24: the rename mark keeps its neutral colour but gains weight and a reason. */
  it('makes the rename mark heavier and names what it was renamed from', () => {
    const html = boot().fileRow(
      fileView({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }),
    );
    expect(html).toContain('class="status status-renamed"');
    expect(html).toContain('title="Renamed from src/old.ts"');
    expect(styleBlock()).toContain('.status-renamed { color: var(--k-text-dim); font-weight: bolder; }');
  });

  /**
   * DF-4: an action appears only where it can work. A committed file is not in
   * the index or the worktree as a pending change; a staged file cannot be
   * `git clean`ed; a deleted file has nothing to open.
   */
  describe('row actions per group (DF-4)', () => {
    const actions = (group: FileGroup, status: ChangedFileView['status'] = 'modified'): string => {
      const html = boot().fileRow(fileView({ status }), group);
      const set = /<span class="file-actions">([\s\S]*?)<\/span>/.exec(html)?.[1] ?? '';
      return set;
    };

    it('offers only "Open current file" on a committed file', () => {
      const set = actions('commit');
      expect(set).toContain('data-open-file="ch-1"');
      expect(set).toContain('aria-label="Open current file"');
      expect(set).not.toContain('data-discard');
      expect(set).not.toContain('data-unstage');
    });

    it('offers Open file and Unstage on a staged file, never Discard', () => {
      const set = actions('staged');
      expect(set).toContain('data-open-file="ch-1"');
      expect(set).toContain('data-unstage="ch-1"');
      expect(set).not.toContain('data-discard');
    });

    it('offers Open file and Discard on an unstaged file, never Unstage', () => {
      const set = actions('unstaged');
      expect(set).toContain('data-open-file="ch-1"');
      expect(set).toContain('data-discard="ch-1"');
      expect(set).not.toContain('data-unstage');
    });

    it('offers Open file and Discard on an untracked file', () => {
      const set = actions('untracked');
      expect(set).toContain('data-open-file="ch-1"');
      expect(set).toContain('data-discard="ch-1"');
    });

    it('offers no Open file on a deleted file, in any group', () => {
      expect(actions('unstaged', 'deleted')).not.toContain('data-open-file');
      expect(actions('staged', 'deleted')).not.toContain('data-open-file');
      expect(actions('commit', 'deleted')).not.toContain('data-open-file');
    });

    it('names the discarded path in the danger icon button', () => {
      const set = actions('unstaged');
      expect(set).toContain('class="k-iconbtn k-iconbtn--danger"');
      expect(set).toContain('aria-label="Discard changes to src/app.ts"');
    });

    it('draws every row action as a catalog svg, never a unicode glyph', () => {
      const set = actions('staged') + actions('unstaged') + actions('commit');
      const buttons = set.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
      expect(buttons.length).toBeGreaterThanOrEqual(5);
      for (const button of buttons) {
        expect(button).toContain('<svg class="k-icon"');
      }
      // The row actions themselves carry no unicode glyphs.
      expect(boot().fileRow(fileView(), 'staged')).not.toMatch(/[↗↩⊖⧉]/);
    });
  });
});

describe('ticket changes webview empty states', () => {
  it('starts loading, not empty, before the first host message (DF-12)', () => {
    const harness = boot();
    expect(harness.repos.innerHTML).toContain('Loading ticket worktrees…');
    expect(harness.summary.textContent).toBe('Loading…');
  });

  it('shows the no-worktrees state with a way to open the ticket once a state arrives (DF-14)', () => {
    const harness = boot();
    harness.render(stateOf([], { commitCount: 0, pendingCount: 0 }), false);
    expect(harness.repos.innerHTML).toContain('<div class="k-empty">');
    expect(harness.repos.innerHTML).toContain('This ticket has no worktrees yet.');
    expect(harness.repos.innerHTML).toContain('Karst creates them when the ticket session starts.');
    expect(harness.summary.textContent).toBe('0 worktrees · 0 commits · 0 pending');
  });

  it('posts open-ticket from the empty state action, and nothing else', () => {
    const harness = boot();
    harness.render(stateOf([], { commitCount: 0, pendingCount: 0 }), false);
    harness.clickData('open-ticket');
    expect(harness.posted).toEqual([{ type: 'open-ticket' }]);
  });

  it('shows the loading state while a first refresh is in flight without changing the label (UI-R18)', () => {
    const harness = boot();
    harness.render(null, true);
    expect(harness.repos.innerHTML).toContain('Loading ticket worktrees…');
    expect(harness.refresh.disabled).toBe(true);
    expect(harness.refresh.attrs['aria-busy']).toBe('true');
  });

  it('shows the all-clean banner above the repository rows (DF-14)', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView(), worktreeView({ label: 'web' })], { commitCount: 0, pendingCount: 0 }), false);
    expect(harness.repos.innerHTML).toContain('No changes yet.');
    expect(harness.repos.innerHTML).toContain('The worktrees have no commits and no pending files.');
    expect(harness.repos.innerHTML).toContain('<strong>api</strong>');
    expect(harness.summary.textContent).toBe('2 worktrees · 0 commits · 0 pending');
  });

  it('never calls a repository with an error clean', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView({ error: 'boom' })], { commitCount: 0, pendingCount: 0 }), false);
    expect(harness.repos.innerHTML).not.toContain('No changes yet.');
    expect(harness.repos.innerHTML).toContain('<section class="repo error">');
  });

  it('shows the no-match state when a filter excludes every repository', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 }), false);
    harness.filterBy('zzz-absent');
    expect(harness.repos.innerHTML).toBe(
      '<div class="k-empty"><div class="k-empty-title">No changes match this filter. Clear the filter to see all repositories.</div></div>',
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

  describe('row action requests (DF-2, DF-22)', () => {
    it('posts a requestId with open-file and enters pending on that button', () => {
      const harness = boot();
      const button = harness.clickAction('open-file', 'ch-1');
      expect(harness.posted).toEqual([
        { type: 'open-file', changeId: 'ch-1', requestId: expect.any(String) },
      ]);
      expect(button.disabled).toBe(true);
      expect(button.attrs['aria-busy']).toBe('true');
    });

    it('posts a requestId with discard and enters pending on that button', () => {
      const harness = boot();
      const button = harness.clickAction('discard', 'ch-2');
      expect(harness.posted).toEqual([
        { type: 'discard', changeId: 'ch-2', requestId: expect.any(String) },
      ]);
      expect(button.disabled).toBe(true);
      expect(button.attrs['aria-busy']).toBe('true');
    });

    it('posts a requestId with unstage and enters pending on that button', () => {
      const harness = boot();
      const button = harness.clickAction('unstage', 'ch-3');
      expect(harness.posted).toEqual([
        { type: 'unstage', changeId: 'ch-3', requestId: expect.any(String) },
      ]);
      expect(button.disabled).toBe(true);
      expect(button.attrs['aria-busy']).toBe('true');
    });

    it('drops a repeat click on a pending action button rather than posting again', () => {
      const harness = boot();
      const button = harness.clickAction('discard', 'ch-2');
      harness.fireAction(button);
      expect(harness.posted).toHaveLength(1);
    });

    it('settles an action button on the host action-result (UI-R13)', () => {
      const harness = boot();
      const button = harness.clickAction('open-file', 'ch-1');
      const requestId = (harness.posted[0] as { requestId: string }).requestId;
      harness.receive({ type: 'action-result', requestId, ok: false, message: 'File missing' });
      expect(button.disabled).toBe(false);
      expect(button.attrs['aria-busy']).toBeUndefined();
    });
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
    // The shared Tabler check, not a text glyph (DF-20).
    expect(button.innerHTML).toContain('M5 12l5 5l10 -10');
    expect(button.label).toBe('Copied');
    // Tier 3 (confirm): the shared .is-success class is the in-place check.
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
    expect(harness.repos.innerHTML).toContain('Loading ticket worktrees…');
  });

  it('persists snapshot, loading flag, view mode and open state, and restores them on reload', () => {
    const harness = boot();
    const state = stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 });
    harness.receive({ type: 'loading', state });
    expect(harness.saved.at(-1)).toEqual({ state, loading: true, viewMode: 'tree', openState: {}, karstPanel: { ticketId: state.ticketId } });

    harness.clickView('flat');
    expect(harness.saved.at(-1)).toEqual({ state, loading: true, viewMode: 'flat', openState: {}, karstPanel: { ticketId: state.ticketId } });

    const reloaded = boot({ state, loading: true, viewMode: 'flat' });
    expect(reloaded.refresh.disabled).toBe(true);
    expect(reloaded.summary.textContent).toBe('1 worktree · 0 commits · 0 pending');
    expect(reloaded.repos.innerHTML).toContain('<strong>api</strong>');
  });

  it('records the host-named ticket as the panel identity before any state arrives, and keeps a restored one', () => {
    const harness = boot();
    harness.receive({ type: 'loading', state: null, ticketId: 41 });
    expect(harness.saved.at(-1)).toMatchObject({ karstPanel: { ticketId: 41 } });

    const reloaded = boot({ state: null, loading: true, viewMode: 'tree', karstPanel: { ticketId: 41 } });
    reloaded.clickView('flat');
    expect(reloaded.saved.at(-1)).toMatchObject({ viewMode: 'flat', karstPanel: { ticketId: 41 } });
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
    expect(html).toContain('<span class="dir-name">src</span><span class="dir-count" title="Files: 2" aria-label="Files: 2">2</span>');
    expect(html).toContain('<span class="dir-name">components</span><span class="dir-count" title="Files: 1" aria-label="Files: 1">1</span>');
  });

  it('joins a single-child directory chain into one row (DF-6)', () => {
    const html = boot().pendingGroup(
      'Changes',
      [fileView({ path: 'src/ui/dashboard/app.ts' })],
      'unstaged',
      'unstaged',
    );
    expect(html).toContain('data-dir="unstaged:src/ui/dashboard"');
    expect(html).toContain('<span class="dir-name">src/ui/dashboard</span>');
    // One directory row for the whole chain, not one per segment.
    expect(html.match(/data-dir="/g)).toHaveLength(1);
  });

  it('keeps a directory with its own files as its own row, even with one child', () => {
    const html = boot().pendingGroup(
      'Changes',
      [fileView({ path: 'src/app.ts' }), fileView({ changeId: 'ch-2', path: 'src/components/Button.tsx' })],
      'unstaged',
      'unstaged',
    );
    expect(html).toContain('<span class="dir-name">src</span>');
    expect(html).toContain('<span class="dir-name">components</span>');
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

  it('toggles the view mode via the segmented radiogroup, mirroring selection in aria-checked (DF-13)', () => {
    const harness = boot();
    expect(harness.viewTree.attrs['aria-checked']).toBe('true');
    expect(harness.viewFlat.attrs['aria-checked']).toBe('false');
    expect(harness.viewTree.classes).toContain('k-btn--secondary');
    expect(harness.viewFlat.classes).toContain('k-btn--ghost');
    harness.clickView('flat');
    expect(harness.viewTree.attrs['aria-checked']).toBe('false');
    expect(harness.viewFlat.attrs['aria-checked']).toBe('true');
    expect(harness.viewTree.classes).toContain('k-btn--ghost');
    expect(harness.viewFlat.classes).toContain('k-btn--secondary');
    harness.clickView('tree');
    expect(harness.viewTree.attrs['aria-checked']).toBe('true');
    expect(harness.viewFlat.attrs['aria-checked']).toBe('false');
  });

  it('marks the view switch as a radiogroup of radios in the markup (DF-13)', () => {
    expect(HTML).toContain('<div class="k-segmented" role="radiogroup" aria-label="View">');
    expect(HTML.match(/role="radio"/g)).toHaveLength(2);
    expect(HTML).toContain('id="viewTree"');
    expect(HTML).toContain('role="radio" aria-checked="true"');
    expect(HTML).toContain('role="radio" aria-checked="false"');
    expect(HTML).toContain('karstIcon(\'list-tree\', 16)');
    expect(HTML).toContain('karstIcon(\'layout-list\', 16)');
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
    expect(harness.viewTree.attrs['aria-checked']).toBe('false');
    expect(harness.viewFlat.attrs['aria-checked']).toBe('true');
    const html = harness.pendingGroup('CHANGES', [fileView({ path: 'src/app.ts' })], 'unstaged');
    expect(html).not.toContain('class="dir"');
  });
});

describe('diffs live regions and filter count (DF-7)', () => {
  it('keeps #repos out of the live regions and leaves only #summary and the filter count live', () => {
    expect(HTML).not.toMatch(/<main[^>]*id="repos"[^>]*aria-live/);
    expect(HTML).toMatch(/<main id="repos">/);
    const live = [...HTML.matchAll(/aria-live="([^"]*)"/g)].map((m) => m[1]);
    expect(live).toHaveLength(2);
    expect(HTML).toContain('<span id="summary" aria-live="polite">');
    expect(HTML).toContain('id="filterCount"');
  });

  it('announces how many files a filter leaves visible, and nothing when no filter is active', () => {
    const harness = boot();
    harness.render(
      stateOf(
        [worktreeView({ unstaged: [fileView(), fileView({ changeId: 'ch-2', path: 'src/b.ts' })] })],
        { commitCount: 0, pendingCount: 2 },
      ),
      false,
    );
    expect(harness.filterCount.textContent).toBe('');
    harness.filterBy('app.ts');
    expect(harness.filterCount.textContent).toBe('Files: 2');
    harness.filterBy('');
    expect(harness.filterCount.textContent).toBe('');
  });
});

describe('diffs open state and focus return (DF-8)', () => {
  const HASH = commitView().hash;

  it('keys every repository, group and commit disclosure', () => {
    const html = boot().worktreeRow(
      worktreeView({
        commits: [commitView({ files: [fileView()] })],
        staged: [fileView({ changeId: 's1', path: 'src/s.ts' })],
      }),
    );
    expect(html).toContain('data-key="repo:api"');
    expect(html).toContain('data-key="group:api:commits"');
    expect(html).toContain('data-key="group:api:staged"');
    expect(html).toContain(`data-key="commit:${HASH}"`);
  });

  it('keeps a collapsed commit collapsed across a new host state', () => {
    const harness = boot();
    const state = (): TicketChangesState =>
      stateOf([worktreeView({ commits: [commitView({ files: [fileView()] })] })], { commitCount: 1, pendingCount: 0 });
    harness.render(state(), false);
    expect(harness.repos.innerHTML).toContain(`data-key="commit:${HASH}" open>`);
    harness.toggleKey(`commit:${HASH}`, false);
    harness.receive({ type: 'state', state: state() });
    expect(harness.repos.innerHTML).toContain(`data-key="commit:${HASH}">`);
    expect(harness.repos.innerHTML).not.toContain(`data-key="commit:${HASH}" open>`);
  });

  it('saves the open state in vscode.setState', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView({ commits: [commitView()] })], { commitCount: 1, pendingCount: 0 }), false);
    harness.toggleKey(`commit:${HASH}`, false);
    expect(harness.saved.at(-1)).toMatchObject({ openState: { [`commit:${HASH}`]: false } });
  });

  it('returns focus to the same row after a refresh', () => {
    const harness = boot();
    const state = (): TicketChangesState =>
      stateOf([worktreeView({ commits: [commitView({ files: [fileView()] })] })], { commitCount: 1, pendingCount: 0 });
    harness.render(state(), false);
    harness.focusKey(`commit:${HASH}`);
    expect(harness.activeKey()).toBe(`commit:${HASH}`);
    harness.receive({ type: 'state', state: state() });
    expect(harness.activeKey()).toBe(`commit:${HASH}`);
  });

  it('focuses the same file row by data-change-id after a refresh', () => {
    const harness = boot();
    const state = (): TicketChangesState =>
      stateOf([worktreeView({ unstaged: [fileView({ path: 'app.ts' })] })], { commitCount: 0, pendingCount: 1 });
    harness.render(state(), false);
    harness.focusChange('ch-1');
    expect(harness.activeChangeId()).toBe('ch-1');
    harness.receive({ type: 'state', state: state() });
    expect(harness.activeChangeId()).toBe('ch-1');
  });

  it('focuses the next row when the focused file is gone', () => {
    const harness = boot();
    const first = fileView({ changeId: 'ch-1', path: 'app.ts' });
    const second = fileView({ changeId: 'ch-2', path: 'b.ts' });
    harness.render(
      stateOf([worktreeView({ unstaged: [first, second] })], { commitCount: 0, pendingCount: 2 }),
      false,
    );
    harness.focusChange('ch-1');
    harness.receive({
      type: 'state',
      state: stateOf(
        [worktreeView({ unstaged: [second, fileView({ changeId: 'ch-3', path: 'c.ts' })] })],
        { commitCount: 0, pendingCount: 2 },
      ),
    });
    expect(harness.activeChangeId()).toBe('ch-2');
  });
});

describe('diffs keyboard (DF-9)', () => {
  const twoFiles = (): TicketChangesState =>
    stateOf(
      [worktreeView({ unstaged: [fileView({ path: 'app.ts' }), fileView({ changeId: 'ch-2', path: 'b.ts' })] })],
      { commitCount: 0, pendingCount: 2 },
    );

  it('moves the roving focus with Up, Down, Home and End', () => {
    const harness = boot();
    harness.render(twoFiles(), false);
    harness.focusKey('repo:api');
    harness.press('ArrowDown');
    expect(harness.activeKey()).toBe('group:api:unstaged');
    harness.press('ArrowDown');
    expect(harness.activeChangeId()).toBe('ch-1');
    harness.press('ArrowDown');
    expect(harness.activeChangeId()).toBe('ch-2');
    harness.press('ArrowDown');
    expect(harness.activeChangeId()).toBe('ch-2');
    harness.press('Home');
    expect(harness.activeKey()).toBe('repo:api');
    harness.press('End');
    expect(harness.activeChangeId()).toBe('ch-2');
    harness.press('ArrowUp');
    expect(harness.activeChangeId()).toBe('ch-1');
  });

  it('closes a disclosure with Left and opens it with Right', () => {
    const harness = boot();
    harness.render(twoFiles(), false);
    harness.focusKey('group:api:unstaged');
    harness.press('ArrowLeft');
    expect(harness.saved.at(-1)).toMatchObject({ openState: { 'group:api:unstaged': false } });
    harness.press('ArrowRight');
    expect(harness.saved.at(-1)).toMatchObject({ openState: { 'group:api:unstaged': true } });
  });

  it('sends open-diff on Enter from a focused file row', () => {
    const harness = boot();
    harness.render(twoFiles(), false);
    harness.focusChange('ch-1');
    harness.press('Enter');
    expect(harness.posted).toEqual([
      { type: 'open-diff', changeId: 'ch-1', requestId: expect.any(String) },
    ]);
  });

  it('sends open-file on O, discard on Delete and unstage on U', () => {
    const sent = (key: string): unknown => {
      const harness = boot();
      harness.render(twoFiles(), false);
      harness.focusChange('ch-1');
      harness.press(key);
      return harness.posted[0];
    };
    expect(sent('o')).toMatchObject({ type: 'open-file', changeId: 'ch-1' });
    expect(sent('Delete')).toMatchObject({ type: 'discard', changeId: 'ch-1' });
    expect(sent('u')).toMatchObject({ type: 'unstage', changeId: 'ch-1' });
  });

  it('declares the keys and keeps the row action buttons out of the tab order', () => {
    const row = boot().fileRow(fileView(), 'unstaged');
    expect(row).toContain('aria-keyshortcuts="Enter"');
    expect(row).toContain('tabindex="-1"');
    expect(row).toContain('aria-keyshortcuts="O"');
    expect(row).toContain('aria-keyshortcuts="Delete"');
    expect(row).toContain('title="Discard changes to src/app.ts (Delete)"');
  });

  it('shows the row action buttons on focus within the row', () => {
    const style = styleBlock();
    expect(style).toContain('.file-row:focus-within .file-actions');
  });
});

describe('diffs many files (DF-11)', () => {
  it('renders at most 200 files of a group, then offers all of them', () => {
    const harness = boot();
    const many = diffsRenderFixtures().find((fixture) => fixture.scenario === 'many')!;
    harness.render(many.state, false);
    expect((harness.repos.innerHTML.match(/data-change-id="/g) ?? [])).toHaveLength(200);
    expect(harness.repos.innerHTML).toContain('Show all files (1500)');
    harness.clickData('show-all', 'group:fixture-web:untracked');
    expect((harness.repos.innerHTML.match(/data-change-id="/g) ?? [])).toHaveLength(1500);
  });

  it('debounces the filter with a named 150 ms constant', () => {
    expect(scriptBlock()).toContain('FILTER_DEBOUNCE_MS = 150');
    expect(scriptBlock()).toContain('GROUP_ROW_LIMIT = 200');
  });
});

describe('diffs worktree error row (DF-15)', () => {
  it('names the failure in the row, not an h2, and refreshes inline', () => {
    const harness = boot();
    harness.render(
      stateOf([worktreeView({ error: 'fatal: bad revision' })], { commitCount: 0, pendingCount: 0 }),
      false,
    );
    expect(harness.repos.innerHTML).toContain('Could not read this worktree.');
    expect(harness.repos.innerHTML).toContain('fatal: bad revision');
    expect(harness.repos.innerHTML).not.toContain('<h2>');
    harness.clickData('refresh');
    expect(harness.posted).toEqual([{ type: 'refresh' }]);
  });
});

describe('diffs commit time (DF-16)', () => {
  it('renders a machine-readable time with a human label', () => {
    const html = boot().commitRow(
      commitView({ authoredAt: '2026-11-21T00:49:35+00:00', authoredLabel: 'Nov 21, 2026, 1:49 AM' }),
      0,
    );
    expect(html).toContain(
      '<time datetime="2026-11-21T00:49:35+00:00" title="2026-11-21T00:49:35+00:00">Nov 21, 2026, 1:49 AM</time>',
    );
    expect(html).not.toContain('>2026-11-21T00:49:35+00:00<');
  });
});

describe('diffs width tiers (DF-21)', () => {
  it('uses the 699 and 399 tier edges, never 440', () => {
    const style = styleBlock();
    expect(style).toContain('@media (max-width: 699px)');
    expect(style).toContain('@media (max-width: 399px)');
    expect(style).not.toContain('440px');
  });

  it('removes the body min-width so the page cannot scroll sideways at 320', () => {
    const rule = /body\s*\{([^}]*)\}/.exec(styleBlock())?.[1] ?? '';
    expect(rule).not.toContain('min-width');
  });

  it('stops the directory indent after three levels', () => {
    expect(styleBlock()).toContain('.dir-body .dir-body .dir-body .dir-body { padding-left: 0; }');
  });

  it('keeps the wrapped summary off the ticket label box at the tight tier', () => {
    const rule = /#summary\s*\{([^}]*)\}/.exec(styleBlock())?.[1] ?? '';
    expect(rule).toContain('display: inline-block');
  });
});

describe('diffs count text', () => {
  it('renders the host-built summaryText and countText, not its own plural code', () => {
    const harness = boot();
    const worktree = worktreeView({
      label: 'api',
      commits: [{ hash: 'h1', shortHash: 'h1', subject: 'One', author: 'Ada', authoredAt: 'now', authoredLabel: 'now', files: [] }],
    });
    const state = stateOf([worktree], { commitCount: 1, pendingCount: 0 });
    harness.render(state, false);
    expect(harness.summary.textContent).toBe('1 worktree · 1 commit · 0 pending');
    expect(harness.repos.innerHTML).toContain('1 commit · clean');
    const script = scriptBlock();
    expect(script).not.toContain('commits.length} commits');
    expect(script).not.toContain('state.worktreeCount} worktrees');
  });
});

describe('diffs page header (DF-17)', () => {
  it('uses the one shared .k-pagehead with the page title and no logo mark', () => {
    expect(HTML).toContain('<header class="k-pagehead">');
    expect(HTML).toContain('<div class="k-pagehead-main">');
    expect(HTML).toContain('<div class="k-pagehead-actions">');
    expect(HTML.match(/<h1 class="k-pagehead-title">/g)).toHaveLength(1);
    expect(HTML).toContain('<h1 class="k-pagehead-title">Ticket changes</h1>');
    // The mark is Getting Started only (Q6-A).
    expect(HTML).not.toContain('k-pagehead-mark');
  });

  it('uses the same words for the editor tab title and the page title', () => {
    expect(HTML).toContain('<title>Ticket changes</title>');
  });

  it('shows the ticket label and the host summary on the subtitle line', () => {
    const harness = boot();
    harness.render(stateOf([worktreeView()], { commitCount: 0, pendingCount: 0 }), false);
    expect(harness.ticketLabel.textContent).toBe('T7 · Fix login · ');
    expect(harness.summary.textContent).toBe('1 worktree · 0 commits · 0 pending');
  });

  it('leaves the ticket label empty and says it is loading before any ticket state arrives', () => {
    const harness = boot();
    expect(harness.ticketLabel.textContent).toBe('');
    expect(harness.summary.textContent).toBe('Loading…');
  });

  it('writes the branch line as "{branch} · base {baseRef}"', () => {
    const html = boot().worktreeRow(worktreeView());
    expect(html).toContain('<small>karst/feat/gates · base origin/main</small>');
    expect(html).not.toContain('↔');
  });

  it('hydrates Refresh and the view switch from the shared icon catalog', () => {
    const script = scriptBlock();
    expect(script).toContain("karstIcon('refresh', 16)");
    expect(script).toContain("karstIcon('list-tree', 16)");
    expect(script).toContain("karstIcon('layout-list', 16)");
  });
});

describe('diffs tree layout (DF-5, DF-19, DF-25)', () => {
  it('lays each file row out as a two-column grid, so the actions stay on its line', () => {
    const rule = /\.file-row\s*\{([^}]*)\}/.exec(styleBlock())?.[1] ?? '';
    expect(rule).toContain('display: grid');
    expect(rule).toContain('grid-template-columns: minmax(0, 1fr) auto');
  });

  it('uppercases the group names in type, not in the text', () => {
    const rule = /\.group > summary\s*\{([^}]*)\}/.exec(styleBlock())?.[1] ?? '';
    expect(rule).toContain('text-transform: uppercase');
  });

  it('puts the status span before the path so the grid needs no placement overrides', () => {
    const row = boot().fileRow(fileView(), 'unstaged');
    expect(row.indexOf('<span class="status ')).toBeLessThan(row.indexOf('<span class="file-path"'));
    const style = styleBlock();
    expect(style).not.toMatch(/\.file-path\s*\{[^}]*grid-column/);
    expect(style).not.toMatch(/\.status\s*\{[^}]*grid-column/);
  });

  it('keeps the commit summary to three columns and drops the narrow count overrides', () => {
    const rule = /\.commit > summary\s*\{([^}]*)\}/.exec(styleBlock())?.[1] ?? '';
    expect(rule).toContain('grid-template-columns: auto minmax(0, 1fr) auto');
    const style = styleBlock();
    expect(style).not.toContain('.commit > summary > span { grid-column: 2; grid-row: 2; }');
    expect(style).not.toMatch(/@media \(max-width: 699px\) \{[\s\S]*\.commit > summary/);
  });

  it('drops the local action padding rule and uses the icon button hit area (DF-20)', () => {
    expect(styleBlock()).not.toContain('.file-actions button');
  });
});

describe('diffs webview design-system conformance', () => {
  it('carries the status palette as the last style block (UI-R03)', () => {
    const styles = [...HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!.trim());
    expect(styles.at(-1)).toBe('/*KARST_PALETTE*/');
  });

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
    // @media conditions cannot read a custom property at all — the 699px and
    // 399px tier edges therefore have no token-based alternative. Only the
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
    expect(script).toContain("sendRowAction(row, 'open-diff')");
    expect(script).toMatch(/vscode\.postMessage\(\{\s*type,\s*changeId:\s*row\.dataset\.changeId,\s*requestId\s*\}\)/);
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

  it('colours the change markers with the GitHub default palette (A green, D red, M amber, R neutral)', () => {
    const style = styleBlock();
    expect(style).toContain('.status-added { color: var(--k-success); }');
    expect(style).toContain('.status-deleted { color: var(--k-danger); }');
    // UI-R29: the fill colours (--k-attention 3.12:1 in light, --k-pending 3.63:1 in dark) are not text tones.
    expect(style).toContain('.status-modified { color: var(--k-attention-fg); }');
    expect(style).toContain('.status-renamed { color: var(--k-text-dim); font-weight: bolder; }');
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

describe('content width cap (UI-R48)', () => {
  it('stays uncapped', () => {
    expect(HTML).not.toContain('--k-content-max');
  });
});
