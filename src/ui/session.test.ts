import { describe, it, expect, vi } from 'vitest';
import {
  continueSessionInBackground,
  SessionManager,
  type TerminalHost,
  type FakeTerminal,
} from './session.js';
import type { AgentAdapter, InteractiveCommandOpts } from '../agent/adapter.js';

/** Records the interactive command built, so the test can assert on it. */
function fakeAdapter(binary = 'fake-agent'): {
  adapter: AgentAdapter;
  calls: InteractiveCommandOpts[];
} {
  const calls: InteractiveCommandOpts[] = [];
  const adapter: AgentAdapter = {
    buildInteractiveCommand: (opts) => {
      calls.push(opts);
      return { command: binary, args: [], env: {} };
    },
    runHeadless: () => Promise.reject(new Error('not used')),
    requiredBinary: binary,
    capabilities: { lifecycleEvents: true, resume: true },
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
        iconPath: opts.iconPath,
        color: opts.color,
        shown: 0,
        disposed: false,
        sent: [],
        show: () => term.shown++,
        sendText: (text) => term.sent.push(text),
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
  const channel = {
    endpointUrl: 'http://127.0.0.1:4567/hooks',
    configDir: '/runtime',
  };
  const channelFor = () => channel;

  it('openSession creates a terminal in the worktree cwd', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.cwd).toBe('/wt/a');
  });

  it('names the terminal by ticket key with the title as description', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a', { key: 'PROJ-42', title: 'Fix login' });
    expect(terminals[0]!.name).toBe('Karst: PROJ-42');
    expect(terminals[0]!.description).toBe('Fix login');
  });

  it('uses the naming bag for terminal name, icon and color when provided', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(
      adapter,
      1,
      '/wt/a',
      { key: 'PROJ-42', title: 'Fix login' },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        name: 'Karst: PROJ-42 · impl',
        iconPath: '/store/icons/karst-blue.svg',
        color: 'terminal.ansiBlue',
      },
    );
    expect(terminals[0]!.name).toBe('Karst: PROJ-42 · impl');
    expect(terminals[0]!.iconPath).toBe('/store/icons/karst-blue.svg');
    expect(terminals[0]!.color).toBe('terminal.ansiBlue');
    // The bag carries the whole rendered name — no separate description fold.
    expect(terminals[0]!.description).toBeUndefined();
  });

  it('falls back to #id in the name when no key is given', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 7, '/wt/a');
    expect(terminals[0]!.name).toBe('Karst: #7');
  });

  it('passes a provider-neutral hook channel to the selected adapter', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a');
    expect(calls[0]!.hookChannel).toEqual(channel);
  });

  it('uses the adapter supplied for each new session', () => {
    const a = fakeAdapter('claude');
    const b = fakeAdapter('codex');
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(a.adapter, 1, '/wt/a');
    mgr.openSession(b.adapter, 2, '/wt/b');

    expect(terminals.map((terminal) => terminal.shellPath)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('keeps the adapter that created an existing ticket session', () => {
    const first = fakeAdapter('codex');
    const second = fakeAdapter('claude');
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(first.adapter, 1, '/wt/a');
    mgr.openSession(second.adapter, 1, '/wt/a');

    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.shellPath).toBe('codex');
  });

  it('the adapter cwd matches the terminal cwd (interactive scoped to worktree)', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 2, '/wt/b');
    expect((calls[0] as { cwd: string }).cwd).toBe('/wt/b');
  });

  it('re-opening the same ticket focuses the existing terminal (no duplicate)', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a');
    mgr.openSession(adapter, 1, '/wt/a');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.shown).toBe(2);
  });

  it('separate tickets get separate terminals', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');
    mgr.openSession(adapter, 2, '/wt/b');
    expect(terminals).toHaveLength(2);
  });

  it('focusSession reveals an open terminal', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');
    const before = terminals[0]!.shown;
    mgr.focusSession(1);
    expect(terminals[0]!.shown).toBe(before + 1);
  });

  it('nudge types a prompt without revealing the IDE terminal', () => {
    // The gate now runs while the session is still open, so a failed gate has to
    // reach the agent that is already sitting at its prompt — openSession would
    // only focus the terminal and drop the brief on the floor.
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');
    const before = terminals[0]!.shown;

    expect(mgr.nudge(1, 'review failed: lint')).toBe(true);
    expect(terminals[0]!.sent).toEqual(['review failed: lint']);
    expect(terminals[0]!.shown).toBe(before);
  });

  it('can launch an automated continuation without revealing the IDE terminal', () => {
    const { adapter } = fakeAdapter('codex');
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(
      adapter,
      1,
      '/wt/a',
      undefined,
      'continue',
      undefined,
      undefined,
      'session-1',
      undefined,
      [],
      { reveal: false },
    );

    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.shown).toBe(0);
  });

  it('keeps an automated re-open of an existing terminal in the background', () => {
    const { adapter } = fakeAdapter('codex');
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');

    mgr.openSession(
      adapter,
      1,
      '/wt/a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      { reveal: false },
    );

    expect(terminals[0]!.shown).toBe(1);
  });

  it('opens a closed automated continuation with reveal disabled', () => {
    const open = vi.fn();
    const sessions = { nudge: vi.fn(() => false) };

    expect(continueSessionInBackground(sessions, open, 7, 'fix it')).toBe(false);
    expect(open).toHaveBeenCalledWith(7, { reveal: false });
  });

  it('nudges a live automated continuation without opening another session', () => {
    const open = vi.fn();
    const sessions = { nudge: vi.fn(() => true) };

    expect(continueSessionInBackground(sessions, open, 7, 'fix it')).toBe(true);
    expect(sessions.nudge).toHaveBeenCalledWith(7, 'fix it');
    expect(open).not.toHaveBeenCalled();
  });

  it('nudge sends one line — a newline would submit the prompt half-typed', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');

    mgr.nudge(1, 'The review gate failed.\n\nIt reported: gates failed: test\n\nThen: fire the marker');
    expect(terminals[0]!.sent).toEqual([
      'The review gate failed. It reported: gates failed: test Then: fire the marker',
    ]);
  });

  it('nudge reports no live session rather than silently dropping the prompt', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    expect(mgr.nudge(99, 'anything')).toBe(false);
  });

  it('focusSession on an unopened ticket is a no-op', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    expect(() => mgr.focusSession(99)).not.toThrow();
  });

  it('a closed terminal is dropped so re-open creates a new one', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');
    terminals[0]!.dispose();
    mgr.openSession(adapter, 1, '/wt/a');
    expect(terminals).toHaveLength(2);
  });

  it('passes initialPrompt to buildInteractiveCommand on a fresh launch', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt', { key: 'K-1', title: 't' }, 'seed prompt');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({ cwd: '/wt', initialPrompt: 'seed prompt' })
    );
  });

  it('threads extraArgs (materialized approach) to buildInteractiveCommand', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt', { key: 'K-1', title: 't' }, 'seed', ['--plugin-dir', '/p']);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({ cwd: '/wt', initialPrompt: 'seed', extraArgs: ['--plugin-dir', '/p'] }),
    );
  });

  it('forwards resume to buildInteractiveCommand', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt', { key: 'K-1' }, 'seed', undefined, undefined, 'sess-7');

    expect(calls).toHaveLength(1);
    expect((calls[0] as { resume?: string }).resume).toBe('sess-7');
  });

  it('does not re-seed on re-open (focus path skips buildInteractiveCommand)', () => {
    const { adapter, calls } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt', undefined, 'seed prompt');
    mgr.openSession(adapter, 1, '/wt', undefined, 'seed prompt');

    expect(calls).toHaveLength(1);
  });

  it('isOpen reports true only for a ticket with a live terminal', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a');

    expect(mgr.isOpen(1)).toBe(true);
    expect(mgr.isOpen(2)).toBe(false);
  });

  it('isOpen goes false again once the terminal closes', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a');
    terminals[0]!.dispose();

    expect(mgr.isOpen(1)).toBe(false);
  });

  it('invokes onDidCloseSession with the ticket id after the terminal closes (isOpen already false)', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const closed: number[] = [];
    const mgr = new SessionManager(host, channelFor, (id) => {
      // the map entry must be gone before the callback runs, so a sweep sees no live session
      expect(mgr.isOpen(id)).toBe(false);
      closed.push(id);
    });

    mgr.openSession(adapter, 7, '/wt/a');
    expect(closed).toEqual([]); // not called on open
    terminals[0]!.dispose();

    expect(closed).toEqual([7]);
  });

  it('cleans adapter-owned paths after the terminal closes', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const cleanup = vi.fn();
    const mgr = new SessionManager(host, channelFor, undefined, cleanup);

    mgr.openSession(
      adapter,
      1,
      '/wt/a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['/wt/a/.agents/skills/karst-rpi'],
    );
    terminals[0]!.dispose();

    expect(cleanup).toHaveBeenCalledWith('/wt/a', [
      '/wt/a/.agents/skills/karst-rpi',
    ]);
  });

  it('also cleans paths generated while building the interactive command', () => {
    const { adapter } = fakeAdapter();
    adapter.buildInteractiveCommand = () => ({
      command: 'codex',
      args: [],
      env: {},
      ownedPaths: ['/wt/a/.codex/karst'],
    });
    const { host, terminals } = fakeHost();
    const cleanup = vi.fn();
    const mgr = new SessionManager(host, channelFor, undefined, cleanup);

    mgr.openSession(adapter, 1, '/wt/a');
    terminals[0]!.dispose();

    expect(cleanup).toHaveBeenCalledWith('/wt/a', ['/wt/a/.codex/karst']);
  });
});
