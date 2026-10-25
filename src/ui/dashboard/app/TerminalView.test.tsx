// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { bodyHas, isHidden, mountOverlays, must, press, q, text, type OverlayHarness } from './fixtures/overlaysKit.js';

const state = { ticketId: 7, key: 'FEAT-7', title: 'Seven' } as unknown as DashboardState;

interface Fake {
  opts: Record<string, unknown>;
  opened: boolean;
  written: string;
  disposed: boolean;
  fits: number;
  scrolled: string[];
}
let made: Fake[] = [];

class FakeTerminal {
  fake: Fake;
  constructor(opts: Record<string, unknown>) {
    this.fake = { opts, opened: false, written: '', disposed: false, fits: 0, scrolled: [] };
    made.push(this.fake);
  }
  loadAddon(addon: { fake?: Fake }): void { addon.fake = this.fake; }
  open(): void { this.fake.opened = true; }
  write(s: string): void { this.fake.written += s; }
  dispose(): void { this.fake.disposed = true; }
  scrollPages(n: number): void { this.fake.scrolled.push(`pages:${n}`); }
  scrollToTop(): void { this.fake.scrolled.push('top'); }
  scrollToBottom(): void { this.fake.scrolled.push('bottom'); }
}
class FakeFit {
  fake?: Fake;
  fit(): void { if (this.fake) this.fake.fits += 1; }
}
const installXterm = (): void => {
  vi.stubGlobal('Terminal', FakeTerminal);
  vi.stubGlobal('FitAddon', { FitAddon: FakeFit });
};

beforeEach(() => { made = []; });

const open = (h: OverlayHarness, stage = 'uat', processId: string | null = null): void => h.act(() => h.overlays.openConsole(stage, processId));
const answerStage = (h: OverlayHarness, result: unknown, stage = 'uat'): void => h.emit({ type: 'stage-log', stage, result } as never);
const answerAgent = (h: OverlayHarness, result: unknown, processId = 'tester'): void => h.emit({ type: 'agent-log', processId, result } as never);
const ok = (content: string, truncated = false) => ({ kind: 'ok', content, truncated });
const key = press;

describe('TerminalView — the surface', () => {
  it('starts hidden with nothing drawn', () => {
    mountOverlays(state);
    expect(isHidden('#termView')).toBe(true);
    expect(must('#termView').childElementCount).toBe(0);
  });

  it('opens the stage console: swaps the body, names the stage, shows the loading line and asks the host once', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    expect(isHidden('#termView')).toBe(false);
    expect(bodyHas('term-nav')).toBe(true);
    expect(text('.ttitle')).toBe('Console · UAT');
    expect(text('#tstatus')).toBe('Loading console output…');
    expect(must('#tstatus').getAttribute('role')).toBe('status');
    expect(h.send.stageLogRequest.mock.calls).toEqual([['uat']]);
    expect(h.send.agentLogRequest).not.toHaveBeenCalled();
  });

  it('names a process console by its process and asks for that process’s log', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h, 'uat', 'tester');
    expect(text('.ttitle')).toBe('Console · Tester');
    open(h, 'review', 'review');
    expect(text('.ttitle')).toBe('Console · Review');
    expect(h.send.agentLogRequest.mock.calls).toEqual([['tester'], ['review']]);
  });

  it('titles stages by their long names', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h, 'impl');
    expect(text('.ttitle')).toBe('Console · Implementation');
  });

  it('closes from its Close button: disposes the terminal and restores the dashboard', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    fireEvent.click(must('[data-term="close"]'));
    expect(made[0]!.disposed).toBe(true);
    expect(isHidden('#termView')).toBe(true);
    expect(bodyHas('term-nav')).toBe(false);
    expect(must('#termView').childElementCount).toBe(0);
    expect(h.overlays.getSnapshot().console).toBeNull();
  });

  it('disposes the terminal when the console switches to another process', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    open(h, 'uat', 'tester');
    expect(made.map((m) => m.disposed)).toEqual([true, false]);
  });
});

describe('TerminalView — the terminal', () => {
  it('creates it with the log-viewer options and the token theme, opens it and fits it', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h, 'review');
    const t = made[0]!;
    expect(t.opts).toMatchObject({ convertEol: true, disableStdin: true, cursorBlink: false, scrollback: 10000, allowProposedApi: true });
    expect(t.opts.theme).toEqual({ background: '#1e1e1e', foreground: '#cccccc', cursor: '#3794ff', selectionBackground: 'rgba(127,127,127,.4)' });
    expect(t.opts.fontFamily).toBe('monospace');
    expect(t.opts.fontSize).toBe(13);
    expect(t.opened).toBe(true);
    expect(t.fits).toBeGreaterThanOrEqual(1);
    expect(must('#termHost').classList.contains('termhost')).toBe(true);
  });

  it('writes the stage log into the live terminal and notes a truncation', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    answerStage(h, ok('\x1b[32mpass\x1b[0m\n', true));
    expect(made[0]!.written).toBe('\x1b[32mpass\x1b[0m\n');
    expect(text('#tstatus')).toBe('Console output truncated');
  });

  it('writes the agent log into the live terminal for that process', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h, 'uat', 'tester');
    answerAgent(h, ok('warn\n'));
    expect(made[0]!.written).toBe('warn\n');
    expect(text('#tstatus')).toBe('');
  });

  it('shows a refusal in the view instead of writing to the terminal', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    answerStage(h, { kind: 'error', message: 'The recorded log file is no longer available.' });
    expect(must('#termHost .blurb').textContent).toBe('The recorded log file is no longer available.');
    expect(made.every((m) => m.written === '')).toBe(true);
    expect(text('#tstatus')).toBe('');
  });

  it('drops an answer for another stage, for a process while a stage console is open, and for another process', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    answerStage(h, ok('other'), 'review');
    answerAgent(h, ok('proc'));
    expect(made[0]!.written).toBe('');
    open(h, 'uat', 'tester');
    answerAgent(h, ok('review lane'), 'review');
    answerStage(h, ok('stage answer'));
    expect(made[1]!.written).toBe('');
    expect(text('#tstatus')).toBe('Loading console output…');
  });

  it('drops a late answer once the console has closed', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    h.act(() => h.overlays.closeConsole());
    answerStage(h, ok('late'));
    expect(made[0]!.written).toBe('');
  });

  it('streams live chunks into the open console after the answer', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h, 'uat', 'tester');
    answerAgent(h, ok('start'));
    h.emit({ type: 'agent-output', processId: 'tester', text: '\nstill running' } as never);
    expect(made[0]!.written).toBe('start\nstill running');
    h.emit({ type: 'agent-output', processId: 'review', text: 'wrong process' } as never);
    h.emit({ type: 'stage-output', stage: 'uat', text: 'a process console is not a stage console' } as never);
    expect(made[0]!.written).toBe('start\nstill running');
  });

  it('keeps a chunk that races the answer, behind the persisted tail', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    h.emit({ type: 'stage-output', stage: 'uat', text: 'raced' } as never);
    expect(made[0]!.written).toBe('');
    answerStage(h, ok('tail\n'));
    expect(made[0]!.written).toBe('tail\nraced');
  });

  it('streams stage output into the open stage console only', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    answerStage(h, ok('recorded'));
    h.emit({ type: 'stage-output', stage: 'uat', text: '\n$ test' } as never);
    h.emit({ type: 'stage-output', stage: 'review', text: 'wrong stage' } as never);
    expect(made[0]!.written).toBe('recorded\n$ test');
  });

  it('replaces a refusal with a fresh terminal carrying the live text when output starts', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    answerStage(h, { kind: 'error', message: 'No console output has been recorded for this stage yet.' });
    expect(q('#termHost .blurb')).not.toBeNull();
    h.emit({ type: 'stage-output', stage: 'uat', text: '\n$ test\nrunning' } as never);
    expect(q('#termHost .blurb')).toBeNull();
    expect(made).toHaveLength(2);
    expect(made[1]!.written).toBe('\n$ test\nrunning');
    expect(made[0]!.disposed).toBe(true);
    h.emit({ type: 'stage-output', stage: 'uat', text: '!' } as never);
    expect(made[1]!.written).toBe('\n$ test\nrunning!');
  });

  it('recovers an agent console the same way', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h, 'uat', 'tester');
    answerAgent(h, { kind: 'error', message: 'This process has no recorded console output.' });
    h.emit({ type: 'agent-output', processId: 'tester', text: 'first line\n' } as never);
    expect(made).toHaveLength(2);
    expect(made[1]!.written).toBe('first line\n');
  });

  it('pages and jumps the scrollback by key, leaving modified keys alone', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    expect(key('PageUp').defaultPrevented).toBe(true);
    key('PageDown');
    key('Home');
    key('End');
    expect(made[0]!.scrolled).toEqual(['pages:-1', 'pages:1', 'top', 'bottom']);
    expect(key('PageUp', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key('a').defaultPrevented).toBe(false);
    expect(made[0]!.scrolled).toHaveLength(4);
  });

  it('disposes the terminal when the whole app goes away', () => {
    installXterm();
    const h = mountOverlays(state);
    open(h);
    cleanup();
    expect(made[0]!.disposed).toBe(true);
    void h;
  });
});

describe('TerminalView — lazy xterm delivery', () => {
  const deliver = (): void => {
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      installXterm();
      appended.push(node as unknown as HTMLScriptElement);
      return node;
    });
  };
  const appended: HTMLScriptElement[] = [];
  beforeEach(() => { appended.length = 0; });

  it('asks for the bundle on the first open and shows the loading line, with no terminal yet', () => {
    const h = mountOverlays(state);
    open(h);
    expect(h.send.xtermRequest).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(0);
    expect(q('#termHost .blurb')).toBeNull();
    expect(text('#tstatus')).toBe('Loading console output…');
  });

  it('runs the delivered bundle under the page nonce, then opens the terminal and fills it with what raced', () => {
    deliver();
    const tag = document.createElement('script');
    tag.setAttribute('nonce', 'abc');
    document.head.prepend(tag);
    Object.defineProperty(tag, 'nonce', { value: 'PAGE-NONCE' });
    const h = mountOverlays(state);
    open(h);
    answerStage(h, ok('early\n')); // the log answer can win the race against the bundle
    h.emit({ type: 'xterm', js: 'XTERM_BUNDLE' });
    expect(appended.map((s) => [s.nonce, s.textContent])).toEqual([['PAGE-NONCE', 'XTERM_BUNDLE']]);
    expect(made).toHaveLength(1);
    expect(made[0]!.written).toBe('early\n');
    tag.remove();
  });

  it('requests the bundle once: a later console reuses it', () => {
    deliver();
    const h = mountOverlays(state);
    open(h);
    h.emit({ type: 'xterm', js: 'XTERM_BUNDLE' });
    h.act(() => h.overlays.closeConsole());
    open(h);
    expect(h.send.xtermRequest).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
    expect(made).toHaveLength(2);
  });

  it('still takes the bundle when the console closed before it arrived', () => {
    deliver();
    const h = mountOverlays(state);
    open(h);
    h.act(() => h.overlays.closeConsole());
    h.emit({ type: 'xterm', js: 'XTERM_BUNDLE' });
    expect(appended).toHaveLength(1);
    expect(made).toHaveLength(0);
    open(h);
    expect(made).toHaveLength(1);
  });

  it('degrades to a visible refusal when the host has no bundle', () => {
    const h = mountOverlays(state);
    open(h);
    h.emit({ type: 'xterm', js: null });
    expect(must('#termHost .blurb').textContent).toBe('Console rendering is unavailable in this build.');
    expect(made).toHaveLength(0);
  });
});
