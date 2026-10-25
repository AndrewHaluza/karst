// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import type { DashboardHostBridge, DashboardSender } from './hostBridge.js';
import { DashboardAppProvider } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import { WorktreesPanel } from './WorktreesPanel.js';

const wt = (repo: string, over: Record<string, unknown> = {}) => ({
  ticketId: 1,
  repo,
  repoDisplay: repo,
  path: `/wt/${repo}`,
  branch: `feat/${repo}`,
  baseRef: null,
  baseDefault: 'main',
  baseCandidates: ['main', 'origin/develop'],
  serviceName: undefined,
  depsMode: 'none',
  createdAt: null,
  launchable: false,
  ...over,
});
const stateWith = (worktrees: unknown[]): DashboardState => ({ ticketId: 1, worktrees }) as unknown as DashboardState;

interface Harness {
  readonly send: Record<string, ReturnType<typeof vi.fn>>;
  readonly emit: (message: HostMessage) => void;
}

function mount(initial: DashboardState | null, onRender?: () => void): Harness {
  document.body.innerHTML = '<div class="panel" id="worktreesPanel" data-react-owned="true"></div>';
  let listener: ((message: HostMessage) => void) | null = null;
  const send = {
    showChanges: vi.fn(),
    openWorktreeTerminal: vi.fn(),
    openWorktreeFolder: vi.fn(),
    launchWorktreeExtension: vi.fn(),
    copyWorktreeBranch: vi.fn(),
    changeBaseRef: vi.fn(),
  };
  const bridge: DashboardHostBridge = {
    send: send as unknown as DashboardSender,
    getState: () => (initial ? { state: initial } : null),
    setState: vi.fn(),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const panel = (
    <RegionPortal id="worktreesPanel">
      <WorktreesPanel />
    </RegionPortal>
  );
  render(
    <DashboardAppProvider bridge={bridge}>
      {onRender ? (
        <Profiler id="wt" onRender={onRender}>
          {panel}
        </Profiler>
      ) : (
        panel
      )}
    </DashboardAppProvider>,
  );
  return { send, emit: (message) => act(() => listener?.(message)) };
}

const pending = new Set<Element>();
beforeEach(() => {
  pending.clear();
  let n = 0;
  Object.assign(globalThis, {
    karstRequestId: () => `req-${++n}`,
    karstSettle: vi.fn(),
    karstIsPending: (el: Element) => pending.has(el),
    karstBeginPending: (el: Element) => {
      pending.add(el);
      el.setAttribute('aria-busy', 'true');
    },
    karstIcon: (name: string) =>
      `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-icon="${name}"/></svg>`,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const byAct = (name: string): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(`[data-act="${name}"]`)];
const one = (name: string): HTMLButtonElement => {
  const [el] = byAct(name);
  if (!el) throw new Error(`no [data-act="${name}"]`);
  return el;
};

describe('WorktreesPanel — rendering', () => {
  it('renders an empty body and an untouched header button before the first snapshot', () => {
    mount(null);
    expect(document.querySelector('#worktrees')!.childElementCount).toBe(0);
    expect(one('show-changes').disabled).toBe(false);
  });

  it('shows the empty state and disables the changes button when the ticket has no worktrees', () => {
    mount(stateWith([]));
    expect(document.querySelector('#worktrees .k-empty-title')!.textContent).toBe('No worktrees.');
    expect(one('show-changes').disabled).toBe(true);
  });

  it('gives the icon-only controls a matching aria-label and title', () => {
    mount(stateWith([wt('web', { launchable: true })]));
    for (const el of [one('show-changes'), one('copy-worktree-branch'), one('open-worktree-terminal'), one('open-worktree-folder'), one('launch-worktree-extension')]) {
      expect(el.getAttribute('aria-label')).toBeTruthy();
      expect(el.getAttribute('title')).toBeTruthy();
    }
    expect(one('show-changes').getAttribute('aria-label')).toBe('Show ticket changes');
    expect(one('show-changes').querySelector('svg.k-icon')).not.toBeNull();
  });

  it('offers Launch dev host only on worktrees the host marked launchable', () => {
    mount(stateWith([wt('web'), wt('api', { launchable: true })]));
    expect(byAct('launch-worktree-extension')).toHaveLength(1);
    expect(byAct('launch-worktree-extension')[0]!.dataset.path).toBe('/wt/api');
  });

  it('labels the base with the worktree own baseRef, then the manifest default, never an empty cell', () => {
    mount(stateWith([wt('web', { baseRef: 'origin/develop' }), wt('api'), wt('docs', { baseDefault: '' })]));
    expect([...document.querySelectorAll('.wbasebr')].map((e) => e.textContent)).toEqual(['origin/develop', 'main', '---']);
  });

  it('prefers the service name as the repo label and keeps the repo path as its title', () => {
    mount(stateWith([wt('web', { serviceName: 'storefront', repoDisplay: 'apps/web' })]));
    const label = document.querySelector('.wrepo')!;
    expect(label.textContent).toBe('storefront');
    expect(label.getAttribute('title')).toBe('apps/web');
  });

  it('renders live additions and deletions by repo, and drops them when a full snapshot arrives', () => {
    const h = mount(stateWith([wt('web'), wt('api')]));
    h.emit({ type: 'worktree-stats', stats: [{ repo: 'web', additions: 5, deletions: 2 }] });
    expect(document.querySelectorAll('.wstats')).toHaveLength(1);
    expect(document.querySelector('.wadd')!.textContent).toBe('+5');
    expect(document.querySelector('.wdel')!.textContent).toBe('−2');

    h.emit({ type: 'state', state: stateWith([wt('web'), wt('api')]), live: true });
    expect(document.querySelectorAll('.wstats')).toHaveLength(1);
    h.emit({ type: 'state', state: stateWith([wt('web'), wt('api')]), supplemental: false });
    expect(document.querySelectorAll('.wstats')).toHaveLength(1);

    h.emit({ type: 'state', state: stateWith([wt('web'), wt('api')]) });
    expect(document.querySelectorAll('.wstats')).toHaveLength(0);
  });
});

describe('WorktreesPanel — posting controls', () => {
  it('posts each action once with a request id and goes pending; a repeat click posts nothing', () => {
    const h = mount(stateWith([wt('web', { launchable: true })]));
    const cases: Array<[string, string, unknown[]]> = [
      ['show-changes', 'showChanges', []],
      ['open-worktree-terminal', 'openWorktreeTerminal', ['/wt/web']],
      ['open-worktree-folder', 'openWorktreeFolder', ['/wt/web']],
      ['launch-worktree-extension', 'launchWorktreeExtension', ['/wt/web']],
    ];
    for (const [name, method, args] of cases) {
      const button = one(name);
      fireEvent.click(button);
      expect(h.send[method], name).toHaveBeenCalledTimes(1);
      expect(h.send[method]).toHaveBeenCalledWith(...args, expect.stringMatching(/^req-/));
      expect(button.getAttribute('aria-busy')).toBe('true');
      fireEvent.click(button);
      expect(h.send[method], `${name} repeat`).toHaveBeenCalledTimes(1);
    }
  });

  it('confirms a branch copy optimistically for a beat, then restores the control', () => {
    vi.useFakeTimers();
    const h = mount(stateWith([wt('web')]));
    const button = one('copy-worktree-branch');
    fireEvent.click(button);
    expect(h.send.copyWorktreeBranch).toHaveBeenCalledWith('feat/web', expect.stringMatching(/^req-/));
    expect(button.getAttribute('aria-label')).toBe('Copied');
    expect(button.hasAttribute('data-copied')).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.querySelector('[data-icon="check"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(button.getAttribute('aria-label')).toBe('Copy branch name');
    expect(button.hasAttribute('data-copied')).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
  });
});

describe('WorktreesPanel — base-branch form', () => {
  const open = (repo = 'web'): void => {
    fireEvent.click(document.querySelector(`[data-act="toggle-base-form"][data-repo="${repo}"]`)!);
  };
  const form = (): Element | null => document.querySelector('[data-wbase-popover]');
  const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[data-base-input]')!;

  it('opens on the edit icon and Cancel closes it, posting nothing', () => {
    const h = mount(stateWith([wt('web')]));
    expect(form()).toBeNull();
    open();
    expect(form()).not.toBeNull();
    expect(document.querySelector('.wbase-popover')!.classList.contains('open')).toBe(true);
    fireEvent.click(document.querySelector('.wbaseformacts [data-act="toggle-base-form"]')!);
    expect(form()).toBeNull();
    expect(h.send.changeBaseRef).not.toHaveBeenCalled();
  });

  it('offers the host candidates in a datalist and defaults the rebase switch ON', () => {
    mount(stateWith([wt('web')]));
    open();
    expect([...document.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['main', 'origin/develop']);
    const toggle = one('toggle-rebase-switch');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reads "Rebase onto <base>" only while the typed base is the current one and the switch is ON', () => {
    mount(stateWith([wt('web')]));
    open();
    const primary = one('change-base-ref');
    expect(primary.textContent).toBe('Change base');
    fireEvent.input(input(), { target: { value: ' main ' } });
    expect(primary.textContent).toBe('Rebase onto main');
    fireEvent.click(one('toggle-rebase-switch'));
    expect(primary.textContent).toBe('Change base');
  });

  it('posts a blank base nothing and does not go pending', () => {
    const h = mount(stateWith([wt('web')]));
    open();
    fireEvent.click(one('change-base-ref'));
    expect(h.send.changeBaseRef).not.toHaveBeenCalled();
    expect(one('change-base-ref').getAttribute('aria-busy')).toBeNull();
  });

  it('posts the typed base with the switch state and the request id', () => {
    const h = mount(stateWith([wt('web')]));
    open();
    fireEvent.click(one('toggle-rebase-switch'));
    fireEvent.input(input(), { target: { value: ' origin/develop ' } });
    fireEvent.click(one('change-base-ref'));
    expect(h.send.changeBaseRef).toHaveBeenCalledWith('web', 'origin/develop', false, expect.stringMatching(/^req-/));
    expect(one('change-base-ref').getAttribute('aria-busy')).toBe('true');
  });

  it('keeps the draft across pushes, closes on the success ack and stays open on a refusal', () => {
    const h = mount(stateWith([wt('web')]));
    open();
    fireEvent.input(input(), { target: { value: 'origin/develop' } });
    fireEvent.click(one('change-base-ref'));
    const requestId = h.send.changeBaseRef!.mock.calls[0]![3] as string;

    h.emit({ type: 'state', state: stateWith([wt('web', { baseCandidates: ['a'] })]) });
    expect(input().value).toBe('origin/develop');

    h.emit({ type: 'action-result', requestId: 'someone-else', ok: true });
    expect(form()).not.toBeNull();
    h.emit({ type: 'action-result', requestId, ok: false, message: 'refused' });
    expect(form()).not.toBeNull();
    expect(input().value).toBe('origin/develop');
  });

  it('closes on the success ack of its own request', () => {
    const h = mount(stateWith([wt('web')]));
    open();
    fireEvent.input(input(), { target: { value: 'origin/develop' } });
    fireEvent.click(one('change-base-ref'));
    const requestId = h.send.changeBaseRef!.mock.calls[0]![3] as string;
    h.emit({ type: 'action-result', requestId, ok: true });
    expect(form()).toBeNull();
  });

  it('closes on Escape and on an outside click, but not on a click in its own pill or popover', () => {
    mount(stateWith([wt('web'), wt('api')]));
    open();
    fireEvent.click(document.querySelector('.wbase-popover .k-field-help')!);
    expect(form()).not.toBeNull();
    fireEvent.click(document.querySelector('.wbase')!);
    expect(form()).not.toBeNull();
    fireEvent.click(document.body);
    expect(form()).toBeNull();

    open();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(form()).toBeNull();
    open();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(form()).not.toBeNull();
  });

  it('discards the draft when the form closes', () => {
    mount(stateWith([wt('web')]));
    open();
    fireEvent.input(input(), { target: { value: 'typed' } });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    open();
    expect(input().value).toBe('');
  });
});

describe('WorktreesPanel — slice selection (migration plan A4)', () => {
  it('does not re-render on a live push whose worktrees slice is structurally unchanged', () => {
    const onRender = vi.fn();
    const h = mount(stateWith([wt('web')]), onRender);
    const before = onRender.mock.calls.length;

    // A fresh object graph each second, as the host sends it: same content, new identity.
    h.emit({ type: 'state', state: { ...stateWith([wt('web')]), clock: 'tick-1' } as unknown as DashboardState, live: true });
    h.emit({ type: 'state', state: { ...stateWith([wt('web')]), clock: 'tick-2' } as unknown as DashboardState, live: true });
    expect(onRender.mock.calls.length).toBe(before);

    h.emit({ type: 'state', state: stateWith([wt('web'), wt('api')]), live: true });
    expect(onRender.mock.calls.length).toBeGreaterThan(before);
    expect(document.querySelectorAll('.wtwrap')).toHaveLength(2);
  });
});

describe('RegionPortal', () => {
  it('throws when its container is missing from the page', () => {
    document.body.innerHTML = '';
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<RegionPortal id="nowhere">x</RegionPortal>)).toThrow(/#nowhere region container is missing/);
    quiet.mockRestore();
    expect(screen.queryByText('x')).toBeNull();
  });
});
