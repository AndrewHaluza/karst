// @vitest-environment jsdom
/** The overlay stack: which overlay is open, the one Escape chain, the artifact navigation with its scroll memory. */
import { describe, expect, it, vi } from 'vitest';
import type { DashboardState } from '../state.js';
import { OverlayStack, type ArtScrolls, type ArtView, type OverlayDeps, type ScrollPort } from './overlayStack.js';
import type { PersistArt } from './artSeam.js';

const state = (over: Record<string, unknown> = {}): DashboardState => ({ ticketId: 7, key: 'FEAT-7', title: 'Seven', brief: '', description: '', ...over }) as unknown as DashboardState;

function make(opts: { state?: DashboardState | null; art?: ArtView | null; scrolls?: ArtScrolls; top?: number } = {}) {
  let top = opts.top ?? 0;
  const written: number[] = [];
  const scroll: ScrollPort = { read: () => top, write: (n) => { top = n; written.push(n); } };
  const persisted: PersistArt[] = [];
  const send = { xtermRequest: vi.fn(), stageLogRequest: vi.fn(), agentLogRequest: vi.fn() };
  const deps: OverlayDeps = {
    send: send as unknown as OverlayDeps['send'],
    getState: () => (opts.state === undefined ? state() : opts.state),
    scroll,
    persistArt: (detail) => void persisted.push(detail),
    restored: { art: opts.art ?? null, scrolls: opts.scrolls ?? { ticket: 0, index: 0, detail: {} } },
  };
  const stack = new OverlayStack(deps);
  return { stack, send, persisted, written, scrollTo: (n: number) => { top = n; }, top: () => top };
}

describe('OverlayStack — ticket-data drawer', () => {
  it('opens with the fetched brief verbatim and posts nothing', () => {
    const { stack, send } = make({ state: state({ brief: '  # T\n\n## Details  ' }) });
    stack.openTicketData();
    expect(stack.getSnapshot().drawer).toEqual({ text: '# T\n\n## Details' });
    expect(Object.values(send).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('falls back to the ticket’s own heading and prompt when it has no brief', () => {
    const { stack } = make({ state: state({ key: 'M-1', title: 'Manual ticket', description: ' Fix the login modal ' }) });
    stack.openTicketData();
    expect(stack.getSnapshot().drawer?.text).toBe('# M-1 — Manual ticket\n\nFix the login modal');
  });

  it('uses the canonical short id when the ticket has no key, and omits an empty prompt', () => {
    const { stack } = make({ state: state({ key: '', title: '', description: '' }) });
    stack.openTicketData();
    expect(stack.getSnapshot().drawer?.text).toBe('# T7');
  });

  it('does not open before the first snapshot', () => {
    const { stack } = make({ state: null });
    stack.openTicketData();
    expect(stack.getSnapshot().drawer).toBeNull();
  });

  it('returns focus to the element that had it when it opened', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { stack } = make();
    stack.openTicketData();
    document.body.focus();
    stack.closeTicketData();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('OverlayStack — console', () => {
  it('asks for the xterm bundle once, then the stage log', () => {
    const { stack, send } = make();
    stack.openConsole('uat', null);
    expect(stack.getSnapshot().console).toEqual({ stage: 'uat', processId: null });
    expect(stack.getSnapshot().xterm).toBe('loading');
    expect(send.xtermRequest).toHaveBeenCalledTimes(1);
    expect(send.stageLogRequest).toHaveBeenCalledWith('uat');
    expect(send.xtermRequest.mock.invocationCallOrder[0]).toBeLessThan(send.stageLogRequest.mock.invocationCallOrder[0]!);
  });

  it('asks for a process’s log with the process id, and never the stage log', () => {
    const { stack, send } = make();
    stack.openConsole('uat', 'tester');
    expect(send.agentLogRequest).toHaveBeenCalledWith('tester');
    expect(send.stageLogRequest).not.toHaveBeenCalled();
  });

  it('is a no-op while the same console is already open', () => {
    const { stack, send } = make();
    stack.openConsole('uat', null);
    stack.openConsole('uat', null);
    expect(send.stageLogRequest).toHaveBeenCalledTimes(1);
  });

  it('switches to another console, asking for its log', () => {
    const { stack, send } = make();
    stack.openConsole('uat', null);
    stack.openConsole('uat', 'tester');
    expect(stack.getSnapshot().console).toEqual({ stage: 'uat', processId: 'tester' });
    expect(send.agentLogRequest).toHaveBeenCalledTimes(1);
    expect(send.xtermRequest).toHaveBeenCalledTimes(1);
  });

  it('runs the delivered bundle once and settles the loader on ready or failed', () => {
    const { stack } = make();
    stack.openConsole('uat', null);
    stack.receive({ type: 'xterm', js: null });
    expect(stack.getSnapshot().xterm).toBe('failed');
  });
});

describe('OverlayStack — Escape chain', () => {
  it('closes the drawer first, then the console, then the logs view, then the env editor, then the artifact view', () => {
    vi.stubGlobal('createServerLogsView', () => ({}));
    const { stack } = make();
    stack.openIndex();
    stack.openEnv();
    stack.openLogs();
    stack.openConsole('uat', null);
    stack.openTicketData();
    const open = (): string[] => {
      const s = stack.getSnapshot();
      return [s.drawer && 'drawer', s.console && 'console', s.logs && 'logs', s.env && 'env', s.art && 'art'].filter(Boolean) as string[];
    };
    expect(open()).toEqual(['drawer', 'console', 'logs', 'env', 'art']);
    const seen: string[][] = [];
    while (stack.escape()) seen.push(open());
    expect(seen).toEqual([['console', 'logs', 'env', 'art'], ['logs', 'env', 'art'], ['env', 'art'], ['art'], []]);
    expect(stack.escape()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('yields to the stage menu at its place: after the drawer, before everything else', () => {
    const { stack } = make();
    stack.openIndex();
    stack.openTicketData();
    stack.setStageMenuOpen(true);
    expect(stack.escape()).toBe(true); // the drawer is first
    expect(stack.escape()).toBe(false); // the menu's own handler takes this one
    expect(stack.getSnapshot().art).toBe('index');
    stack.setStageMenuOpen(false);
    expect(stack.escape()).toBe(true);
    expect(stack.getSnapshot().art).toBeNull();
  });

  it('does nothing when nothing is open', () => {
    expect(make().stack.escape()).toBe(false);
  });
});

describe('OverlayStack — logs and env', () => {
  it('refuses to open the logs view without the shared runtime', () => {
    vi.stubGlobal('createServerLogsView', undefined);
    const { stack } = make();
    stack.openLogs();
    expect(stack.getSnapshot().logs).toBe(false);
    vi.unstubAllGlobals();
  });

  it('opens each at most once', () => {
    vi.stubGlobal('createServerLogsView', () => ({}));
    const { stack } = make();
    const seen: boolean[] = [];
    stack.subscribe(() => seen.push(true));
    stack.openLogs();
    stack.openLogs();
    stack.openEnv();
    stack.openEnv();
    expect(seen).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});

describe('OverlayStack — artifact navigation', () => {
  it('opens the index, a detail from the ticket, and a detail from the index with the right origin', () => {
    const { stack } = make();
    stack.openArtifact('plan');
    expect(stack.getSnapshot().art).toEqual({ id: 'plan', from: 'ticket' });
    stack.back();
    stack.openIndex();
    stack.openArtifact('plan');
    expect(stack.getSnapshot().art).toEqual({ id: 'plan', from: 'index' });
  });

  it('opens a detail from the stored view as if from the ticket', () => {
    const { stack } = make();
    stack.openStored();
    stack.openArtifact('plan');
    expect(stack.getSnapshot().art).toEqual({ id: 'plan', from: 'ticket' });
  });

  it('Back is deterministic: detail to its origin, index and stored to the ticket', () => {
    const { stack } = make();
    stack.openIndex();
    stack.openArtifact('plan');
    stack.back();
    expect(stack.getSnapshot().art).toBe('index');
    stack.back();
    expect(stack.getSnapshot().art).toBeNull();
    stack.openArtifact('plan');
    stack.back();
    expect(stack.getSnapshot().art).toBeNull();
    stack.openStored();
    stack.back();
    expect(stack.getSnapshot().art).toBeNull();
    expect(() => stack.back()).not.toThrow();
  });

  it('announces the view and the scroll memory after every navigation, never anything else', () => {
    const { stack, persisted, scrollTo } = make();
    scrollTo(300);
    stack.openIndex();
    expect(persisted.at(-1)).toEqual({ artView: 'index', artScrolls: { ticket: 300, index: 0, detail: {} } });
    scrollTo(40);
    stack.openArtifact('plan');
    expect(persisted.at(-1)).toEqual({ artView: { id: 'plan', from: 'index' }, artScrolls: { ticket: 300, index: 40, detail: {} } });
    scrollTo(900);
    stack.back();
    expect(persisted.at(-1)).toEqual({ artView: 'index', artScrolls: { ticket: 300, index: 40, detail: { plan: 900 } } });
    stack.back();
    expect(persisted.at(-1)?.artView).toBeNull();
    expect(persisted).toHaveLength(4);
  });

  it('announces a copy of the scroll memory, not the live object', () => {
    const { stack, persisted } = make();
    stack.openIndex();
    const first = persisted[0]!.artScrolls;
    stack.openArtifact('plan');
    expect(first.detail).toEqual({});
  });

  it('restores the scroll of the surface now showing', () => {
    const { stack, scrollTo, written } = make({ scrolls: { ticket: 120, index: 60, detail: { plan: 900 } } });
    stack.restoreScroll();
    expect(written.at(-1)).toBe(120);
    stack.openIndex();
    stack.restoreScroll();
    expect(written.at(-1)).toBe(60);
    scrollTo(5);
    stack.openArtifact('plan');
    stack.restoreScroll();
    expect(written.at(-1)).toBe(900);
    stack.back();
    stack.restoreScroll();
    expect(written.at(-1)).toBe(5); // leaving the index for a detail saved where it was read
  });

  it('starts from what the page restored, and a detail without memory restores to the top', () => {
    const { stack, written } = make({ art: { id: 'plan', from: 'index' }, scrolls: { ticket: 0, index: 0, detail: {} } });
    expect(stack.getSnapshot().art).toEqual({ id: 'plan', from: 'index' });
    stack.restoreScroll();
    expect(written.at(-1)).toBe(0);
  });

  it('falls back to the index for a vanished artifact without touching the scroll memory', () => {
    const { stack, persisted, written } = make({ art: { id: 'gone', from: 'ticket' } });
    stack.fallbackToIndex();
    expect(stack.getSnapshot().art).toBe('index');
    expect(persisted.at(-1)?.artView).toBe('index');
    expect(written).toEqual([]);
  });
});
