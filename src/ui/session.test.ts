import { describe, it, expect, vi } from 'vitest';
import { SessionManager, type TerminalHost, type FakeTerminal } from './session.js';
import type { AgentAdapter } from '../agent/adapter.js';

/** Records the interactive command built, so the test can assert on it. */
function fakeAdapter(): { adapter: AgentAdapter; calls: unknown[] } {
  const calls: unknown[] = [];
  const adapter: AgentAdapter = {
    buildInteractiveCommand: (opts) => {
      calls.push(opts);
      const args = ['--settings', opts.settingsPath ?? ''];
      return { command: 'claude', args, env: {} };
    },
    runHeadless: () => Promise.reject(new Error('not used')),
    requiredBinary: 'claude',
    capabilities: { httpHooks: true, resume: true },
  };
  return { adapter, calls };
}

function fakeHost(): { host: TerminalHost; terminals: FakeTerminal[] } {
  const terminals: FakeTerminal[] = [];
  const host: TerminalHost = {
    createTerminal: (opts) => {
      const term: FakeTerminal = {
        name: opts.name,
        description: opts.description,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        shown: 0,
        disposed: false,
        show: () => term.shown++,
        dispose: () => {
          term.disposed = true;
          term.disposeHandler?.();
        },
        onDidClose: (h) => (term.disposeHandler = h),
      };
      terminals.push(term);
      return term;
    },
  };
  return { host, terminals };
}

describe('SessionManager', () => {
  const SETTINGS = '/tmp/karst-hooks.json';
  const settingsFor = () => SETTINGS;

  it('openSession creates a terminal in the worktree cwd', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt/a');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.cwd).toBe('/wt/a');
  });

  it('names the terminal by ticket key with the title as description', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt/a', { key: 'PROJ-42', title: 'Fix login' });
    expect(terminals[0]!.name).toBe('Karst: PROJ-42');
    expect(terminals[0]!.description).toBe('Fix login');
  });

  it('falls back to #id in the name when no key is given', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(7, '/wt/a');
    expect(terminals[0]!.name).toBe('Karst: #7');
  });

  it('passes a non-empty settingsPath to the adapter and into the command', () => {
    const { adapter, calls } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt/a');
    expect((calls[0] as { settingsPath?: string }).settingsPath).toBe(SETTINGS);
    expect(terminals[0]!.shellArgs).toContain('--settings');
    expect(terminals[0]!.shellArgs).toContain(SETTINGS);
    expect(terminals[0]!.shellPath).toBe('claude');
  });

  it('the adapter cwd matches the terminal cwd (interactive scoped to worktree)', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);
    mgr.openSession(2, '/wt/b');
    expect((calls[0] as { cwd: string }).cwd).toBe('/wt/b');
  });

  it('re-opening the same ticket focuses the existing terminal (no duplicate)', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt/a');
    mgr.openSession(1, '/wt/a');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.shown).toBeGreaterThanOrEqual(1);
  });

  it('separate tickets get separate terminals', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);
    mgr.openSession(1, '/wt/a');
    mgr.openSession(2, '/wt/b');
    expect(terminals).toHaveLength(2);
  });

  it('focusSession reveals an open terminal', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);
    mgr.openSession(1, '/wt/a');
    const before = terminals[0]!.shown;
    mgr.focusSession(1);
    expect(terminals[0]!.shown).toBe(before + 1);
  });

  it('focusSession on an unopened ticket is a no-op', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);
    expect(() => mgr.focusSession(99)).not.toThrow();
  });

  it('a closed terminal is dropped so re-open creates a new one', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);
    mgr.openSession(1, '/wt/a');
    terminals[0]!.dispose();
    mgr.openSession(1, '/wt/a');
    expect(terminals).toHaveLength(2);
  });

  it('passes initialPrompt to buildInteractiveCommand on a fresh launch', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt', { key: 'K-1', title: 't' }, 'seed prompt');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({ cwd: '/wt', initialPrompt: 'seed prompt' })
    );
  });

  it('threads extraArgs (materialized approach) to buildInteractiveCommand', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt', { key: 'K-1', title: 't' }, 'seed', ['--plugin-dir', '/p']);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({ cwd: '/wt', initialPrompt: 'seed', extraArgs: ['--plugin-dir', '/p'] }),
    );
  });

  it('forwards resume to buildInteractiveCommand', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt', { key: 'K-1' }, 'seed', undefined, undefined, 'sess-7');

    expect(calls).toHaveLength(1);
    expect((calls[0] as { resume?: string }).resume).toBe('sess-7');
  });

  it('does not re-seed on re-open (focus path skips buildInteractiveCommand)', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt', undefined, 'seed prompt');
    mgr.openSession(1, '/wt', undefined, 'seed prompt');

    expect(calls).toHaveLength(1);
  });

  it('isOpen reports true only for a ticket with a live terminal', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt/a');

    expect(mgr.isOpen(1)).toBe(true);
    expect(mgr.isOpen(2)).toBe(false);
  });

  it('isOpen goes false again once the terminal closes', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(adapter, host, settingsFor);

    mgr.openSession(1, '/wt/a');
    terminals[0]!.dispose();

    expect(mgr.isOpen(1)).toBe(false);
  });

  it('invokes onDidCloseSession with the ticket id after the terminal closes (isOpen already false)', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const closed: number[] = [];
    const mgr = new SessionManager(adapter, host, settingsFor, (id) => {
      // the map entry must be gone before the callback runs, so a sweep sees no live session
      expect(mgr.isOpen(id)).toBe(false);
      closed.push(id);
    });

    mgr.openSession(7, '/wt/a');
    expect(closed).toEqual([]); // not called on open
    terminals[0]!.dispose();

    expect(closed).toEqual([7]);
  });
});
