import { describe, it, expect, vi } from 'vitest';
import {
  continueSessionInBackground,
  KARST_LAUNCH_ENV,
  KARST_TICKET_ENV,
  SessionManager,
  ticketIdFromTerminalEnv,
  type TerminalHost,
  type FakeTerminal,
  type RestoredSession,
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

function fakeHost(
  restored: RestoredSession[] = [],
  delayClose = false,
): {
  host: TerminalHost & {
    restoreCreatedTerminals(): void;
    liveTerminals(): FakeTerminal[];
    flushCloseEvents(): void;
  };
  terminals: FakeTerminal[];
} {
  const terminals: FakeTerminal[] = [];
  const pendingCloseEvents: Array<() => void> = [];
  // VS Code keeps a terminal in `window.terminals` until its close event is
  // delivered, not until `dispose()` is called. This tracks delivered closes
  // so the fake's restored-sessions view mirrors that async cleanup gap.
  const closeDelivered = new Set<FakeTerminal>();
  let restoredSessions = restored;
  const host: TerminalHost & {
    restoreCreatedTerminals(): void;
    liveTerminals(): FakeTerminal[];
    flushCloseEvents(): void;
  } = {
    createTerminal: (opts) => {
      const term: FakeTerminal = {
        name: opts.name,
        description: opts.description,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        env: opts.env,
        hideFromUser: opts.hideFromUser,
        iconPath: opts.iconPath,
        color: opts.color,
        shown: 0,
        shownPreserveFocus: [],
        disposed: false,
        sent: [],
        show: (preserveFocus) => {
          // A disposed VS Code terminal throws on `.show()` ("Terminal has
          // already been disposed") — the exact failure this module's
          // recently-disposed guard exists to prevent.
          if (term.disposed) throw new Error('Terminal has already been disposed');
          term.shown++;
          term.shownPreserveFocus.push(preserveFocus);
        },
        sendText: (text) => term.sent.push(text),
        dispose: () => {
          term.disposed = true;
          if (!term.disposeHandler) return;
          if (delayClose) {
            pendingCloseEvents.push(() => {
              closeDelivered.add(term);
              term.disposeHandler?.();
            });
          } else {
            closeDelivered.add(term);
            term.disposeHandler();
          }
        },
        onDidClose: (h) => (term.disposeHandler = h),
      };
      terminals.push(term);
      return term;
    },
    restoredSessions: () => restoredSessions,
    restoreCreatedTerminals: () => {
      // Mirrors `vscode.window.terminals`: a terminal stays listed until its
      // close event is delivered, so a disposed-but-not-yet-closed terminal is
      // still visible (that is what makes the agent-core-switch race real).
      restoredSessions = terminals
        .filter((terminal) => !closeDelivered.has(terminal))
        .flatMap((terminal) => {
          const raw = terminal.env[KARST_TICKET_ENV];
          return typeof raw === 'string' && /^[1-9]\d*$/.test(raw)
            ? [{ ticketId: Number(raw), terminal }]
            : [];
        });
    },
    liveTerminals: () => terminals.filter((terminal) => !terminal.disposed),
    flushCloseEvents: () => {
      for (const close of pendingCloseEvents.splice(0)) close();
    },
  };
  return { host, terminals };
}

/** Close a fake terminal as if the underlying process exited with `exitCode`. */
function closeWithExitCode(terminal: FakeTerminal, exitCode: number | undefined): void {
  terminal.disposed = true;
  terminal.disposeHandler?.(exitCode);
}

function fakeRestored(
  ticketId: number,
): RestoredSession & {
  terminal: {
    shown: number;
    sent: string[];
    disposed: boolean;
    disposeHandler?: (exitCode?: number) => void;
  };
} {
  const terminal = {
    shown: 0,
    sent: [] as string[],
    disposed: false,
    disposeHandler: undefined as ((exitCode?: number) => void) | undefined,
    show: () => terminal.shown++,
    sendText: (text: string) => terminal.sent.push(text),
    dispose: () => {
      terminal.disposed = true;
      terminal.disposeHandler?.();
    },
    onDidClose: (handler: (exitCode?: number) => void) => (terminal.disposeHandler = handler),
  };
  return { ticketId, terminal };
}

describe('SessionManager', () => {
  const launchId = '123e4567-e89b-42d3-a456-426614174000';
  const channel = {
    endpointUrl: 'http://127.0.0.1:4567/hooks',
    configDir: '/runtime',
    launchId,
  };
  const channelFor = () => channel;

  it('tags a new terminal with provider-neutral ticket and launch identity', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(
      adapter,
      7,
      '/wt/a',
      undefined,
      'secret prompt',
      undefined,
      undefined,
      'secret-session',
    );

    expect(terminals[0]!.env).toEqual({
      [KARST_TICKET_ENV]: '7',
      [KARST_LAUNCH_ENV]: launchId,
    });
    expect(JSON.stringify(terminals[0]!.env)).not.toContain('secret');
  });

  it('three reloads retain one provider-neutral restored terminal without relaunching', () => {
    const neverLaunchAdapter: AgentAdapter = {
      buildInteractiveCommand: () => {
        throw new Error('restoration must not build an agent command');
      },
      runHeadless: () => Promise.reject(new Error('not used')),
      requiredBinary: 'any-provider',
      capabilities: { lifecycleEvents: true, resume: true },
    };
    const restored = fakeRestored(7);
    const { host, terminals } = fakeHost([restored]);
    let manager: SessionManager;

    for (let cycle = 1; cycle <= 3; cycle++) {
      manager = new SessionManager(host, channelFor);
      expect(manager.reconcileRestoredSessions(() => 'resume')).toEqual({
        resume: [7],
        idle: [],
      });
      manager.openSession(neverLaunchAdapter, 7, '/wt/a');

      expect(manager.nudge(7, `responsive-${cycle}`)).toBe(true);
      expect(manager.isOpen(7)).toBe(true);
      expect(restored.terminal.disposed).toBe(false);
      expect([restored.terminal].filter((terminal) => !terminal.disposed)).toHaveLength(1);
      expect(terminals).toHaveLength(0);
    }

    expect(restored.terminal.sent).toEqual(['responsive-1', 'responsive-2', 'responsive-3']);
  });

  it('adopts one active restored terminal without creating a replacement', () => {
    const restored = fakeRestored(7);
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost([restored]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.reconcileRestoredSessions(() => 'resume')).toEqual({
      resume: [7],
      idle: [],
    });
    mgr.openSession(adapter, 7, '/wt/a');

    expect(mgr.isOpen(7)).toBe(true);
    expect(restored.terminal.disposed).toBe(false);
    expect(terminals).toHaveLength(0);
  });

  it('adopts an inactive restored terminal and keeps it responsive', () => {
    const restored = fakeRestored(8);
    const { host } = fakeHost([restored]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.reconcileRestoredSessions(() => 'idle')).toEqual({
      resume: [],
      idle: [8],
    });
    expect(mgr.nudge(8, 'continue')).toBe(true);
    expect(restored.terminal.sent).toEqual(['continue']);
    expect(restored.terminal.disposed).toBe(false);
  });

  it('keeps the first duplicate restored handle and disposes later handles', () => {
    const restored = [fakeRestored(7), fakeRestored(7)];
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost(restored);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.reconcileRestoredSessions((id) => (id === 7 ? 'resume' : 'ignore'))).toEqual({
      resume: [7],
      idle: [],
    });
    expect(restored[0]!.terminal.disposed).toBe(false);
    expect(restored[1]!.terminal.disposed).toBe(true);
    mgr.openSession(adapter, 7, '/wt/a');
    expect(terminals).toHaveLength(0);
  });

  it('keeps a tagged non-resumable terminal in recoverable idle state', () => {
    const restored = [fakeRestored(8)];
    const { host } = fakeHost(restored);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.reconcileRestoredSessions(() => 'idle')).toEqual({
      resume: [],
      idle: [8],
    });
    expect(restored[0]!.terminal.disposed).toBe(false);
  });

  it('ignores untagged terminals', () => {
    const unrelated = fakeRestored(9).terminal;
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.reconcileRestoredSessions(() => 'resume')).toEqual({ resume: [], idle: [] });
    expect(unrelated.disposed).toBe(false);
  });

  it('ignores foreign restored terminals without disposing them', () => {
    const foreign = fakeRestored(8);
    const { host } = fakeHost([foreign]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.reconcileRestoredSessions(() => 'ignore')).toEqual({ resume: [], idle: [] });
    expect(foreign.terminal.disposed).toBe(false);
  });

  it('ignores restored terminals when this window has no current project', () => {
    const restored = fakeRestored(8);
    const { host } = fakeHost([restored]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.reconcileRestoredSessions(() => 'ignore')).toEqual({ resume: [], idle: [] });
    expect(restored.terminal.disposed).toBe(false);
  });

  it('openSession creates a terminal in the worktree cwd', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.cwd).toBe('/wt/a');
    expect(terminals[0]!.hideFromUser).toBeUndefined();
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

  it('launches the agent under the terminal display name, so both read alike', () => {
    const { adapter, calls } = fakeAdapter();
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
      { name: 'Karst: PROJ-42 — Fix login' },
    );
    expect(calls[0]!.sessionName).toBe('Karst: PROJ-42 — Fix login');
    expect(calls[0]!.sessionName).toBe(terminals[0]!.name);
  });

  it('names the agent session from the fallback terminal name when no naming bag is given', () => {
    const { adapter, calls } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a', { key: 'PROJ-42', title: 'Fix login' });
    expect(calls[0]!.sessionName).toBe(terminals[0]!.name);
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

  it('launches the opencode binary when the opencode adapter is selected', () => {
    const { adapter } = fakeAdapter('opencode');
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 1, '/wt/a');

    expect(terminals.map((t) => t.shellPath)).toEqual(['opencode']);
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

  it('focusSession can reveal without stealing focus', () => {
    // The dashboard binding reveals the terminal beside a panel the user just
    // clicked — taking focus there would yank the caret out from under them and
    // put the two bound surfaces into a focus ping-pong.
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');
    mgr.focusSession(1, true);
    expect(terminals[0]!.shownPreserveFocus.at(-1)).toBe(true);
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
    expect(terminals[0]!.hideFromUser).toBeUndefined();
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

  // A revived terminal is the live agent; the map is only this host's bookkeeping
  // and is empty after a reload. Nudging had no adoption step, so a failed gate
  // opened a SECOND agent beside the one still sitting at its prompt.
  it('nudges a revived terminal this host has not tracked yet', () => {
    const revived = fakeRestored(7);
    const { host } = fakeHost([revived]);
    const adopted: Array<[number, string | undefined]> = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      undefined,
      (ticketId, id) => adopted.push([ticketId, id]),
    );

    expect(mgr.nudge(7, 'the uat gate failed')).toBe(true);
    expect(revived.terminal.sent).toEqual(['the uat gate failed']);
    // The nudge is automated: it must never yank the user out of what they are doing.
    expect(revived.terminal.shown).toBe(0);
    expect(mgr.isOpen(7)).toBe(true);
    expect(adopted).toEqual([[7, undefined]]);
  });

  it('does not nudge a revived terminal whose agent already exited', () => {
    const revived = { ...fakeRestored(7), exited: true };
    const { host } = fakeHost([revived]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.nudge(7, 'the uat gate failed')).toBe(false);
    expect(revived.terminal.sent).toEqual([]);
    expect(mgr.isOpen(7)).toBe(false);
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

  it('revealSession reveals an open terminal, like focusSession', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 1, '/wt/a');
    const before = terminals[0]!.shown;
    expect(mgr.revealSession(1)).toBe(true);
    expect(terminals[0]!.shown).toBe(before + 1);
  });

  // The inside panel's "Open session" reveal must adopt a revived terminal
  // exactly like `nudge` does — a reload empties this window's `terminals`
  // map while the agent it forgot is still running, and the dispatch that
  // called this already proved a live implementation run exists.
  it('revealSession adopts a revived terminal this host has not tracked yet', () => {
    const revived = fakeRestored(7);
    const { host } = fakeHost([revived]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.revealSession(7)).toBe(true);
    expect(revived.terminal.shown).toBe(1);
    expect(mgr.isOpen(7)).toBe(true);
  });

  it('revealSession on a ticket with no live or revivable session is a no-op', () => {
    const { host } = fakeHost([]);
    const mgr = new SessionManager(host, channelFor);
    expect(mgr.revealSession(99)).toBe(false);
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

  it('disposes an unready recovery terminal so a retry can create a replacement', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost([], true);
    const observedCloses: number[] = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      (ticketId) => observedCloses.push(ticketId),
    );
    mgr.openSession(adapter, 1, '/wt/a');

    mgr.disposeSession(1);
    mgr.openSession(adapter, 1, '/wt/a');
    host.flushCloseEvents();

    expect(terminals).toHaveLength(2);
    expect(terminals[0]!.disposed).toBe(true);
    expect(mgr.isOpen(1)).toBe(true);
    expect(observedCloses).toEqual([1]);
  });

  it('does not adopt a recently-disposed terminal when VS Code still lists it', () => {
    // Simulates the agent core switch race: disposeSession disposes the
    // terminal, but VS Code's async cleanup has not yet delivered its close
    // event, so the disposed terminal is still listed in `window.terminals`
    // with no `exitStatus`. A subsequent openSession must create a fresh
    // terminal instead of adopting the disposed one (whose `.show()` throws
    // "Terminal has already been disposed").
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost([], true);
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 7, '/wt/a');
    expect(terminals).toHaveLength(1);

    // Dispose the session (karst-initiated, not VS Code); the close event is
    // still pending, exactly like the real async gap.
    mgr.disposeSession(7);

    // VS Code still lists the disposed terminal in `window.terminals`.
    host.restoreCreatedTerminals();

    // openSession must NOT adopt the disposed terminal.
    mgr.openSession(adapter, 7, '/wt/a');

    expect(terminals).toHaveLength(2);
    expect(terminals[0]!.disposed).toBe(true);
    expect(terminals[1]!.disposed).toBe(false);
    expect(mgr.isOpen(7)).toBe(true);
  });

  it('holds the disposed-terminal guard until the disposed terminal closes, not a newer session', () => {
    // A newer session closing first must not release the guard: the disposed
    // terminal is still listed in `window.terminals` while its own close is
    // pending, and re-adopting it would throw "Terminal has already been
    // disposed".
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost([], true);
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 7, '/wt/a');
    mgr.disposeSession(7);
    mgr.openSession(adapter, 7, '/wt/a');
    host.restoreCreatedTerminals();

    // The replacement session's close is delivered while the disposed
    // terminal's own close is still pending.
    closeWithExitCode(terminals[1]!, 0);
    host.restoreCreatedTerminals();

    // A third open must still create a fresh terminal, never adopt the corpse.
    mgr.openSession(adapter, 7, '/wt/a');

    expect(terminals).toHaveLength(3);
    expect(terminals[2]!.disposed).toBe(false);
    expect(mgr.isOpen(7)).toBe(true);
  });

  it('cleans owned assets exactly once when deliberately disposed without replacement', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost([], true);
    const cleanup = vi.fn();
    const mgr = new SessionManager(host, channelFor, undefined, cleanup);

    mgr.openSession(adapter, 1, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, [
      '/wt/a/.codex/karst/retired',
    ]);
    mgr.disposeSession(1);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('/wt/a', ['/wt/a/.codex/karst/retired']);

    host.flushCloseEvents();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans retired assets without letting its delayed close clean different replacement assets', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost([], true);
    const cleanup = vi.fn();
    const mgr = new SessionManager(host, channelFor, undefined, cleanup);

    mgr.openSession(adapter, 1, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, [
      '/wt/a/.codex/karst/retired',
    ]);
    mgr.disposeSession(1);
    mgr.openSession(adapter, 1, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, [
      '/wt/a/.codex/karst/replacement',
    ]);

    expect(cleanup.mock.calls).toEqual([
      ['/wt/a', ['/wt/a/.codex/karst/retired']],
    ]);

    host.flushCloseEvents();
    expect(cleanup.mock.calls).toEqual([
      ['/wt/a', ['/wt/a/.codex/karst/retired']],
    ]);
    expect(mgr.isOpen(1)).toBe(true);

    terminals[1]!.dispose();
    host.flushCloseEvents();
    expect(cleanup.mock.calls).toEqual([
      ['/wt/a', ['/wt/a/.codex/karst/retired']],
      ['/wt/a', ['/wt/a/.codex/karst/replacement']],
    ]);
  });

  it('does not clean replacement assets when the old terminal closes late', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost([], true);
    const cleanup = vi.fn();
    const mgr = new SessionManager(host, channelFor, undefined, cleanup);

    mgr.openSession(adapter, 1, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, [
      '/wt/a/.codex/active',
    ]);
    mgr.disposeSession(1);
    mgr.openSession(adapter, 1, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, [
      '/wt/a/.codex/active',
    ]);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenLastCalledWith('/wt/a', ['/wt/a/.codex/active']);

    host.flushCloseEvents();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mgr.isOpen(1)).toBe(true);

    terminals[1]!.dispose();
    host.flushCloseEvents();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenLastCalledWith('/wt/a', ['/wt/a/.codex/active']);
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

  it('reports a resume launch that dies before starting (e.g. `--resume` on a stale session id)', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const failedResumes: number[] = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      undefined,
      undefined,
      (ticketId) => failedResumes.push(ticketId),
    );

    mgr.openSession(adapter, 1, '/wt/a', undefined, 'seed', undefined, undefined, 'sess-stale');
    closeWithExitCode(terminals[0]!, 1);

    expect(failedResumes).toEqual([1]);
  });

  it('reports a failed resume only after retiring the failed launch', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const events: string[] = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      () => events.push('session-closed'),
      undefined,
      () => events.push('terminal-closed'),
      undefined,
      () => {
        events.push('resume-failed');
        mgr.openSession(adapter, 1, '/wt/a', undefined, 'fresh seed');
      },
    );

    mgr.openSession(adapter, 1, '/wt/a', undefined, 'resume seed', undefined, undefined, 'sess-stale');
    closeWithExitCode(terminals[0]!, 1);

    expect(events).toEqual(['session-closed', 'terminal-closed', 'resume-failed']);
    expect(terminals).toHaveLength(2);
    expect(mgr.isOpen(1)).toBe(true);
  });

  it('preserves hidden recovery options when reporting a failed resume', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const failures: unknown[] = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      undefined,
      undefined,
      (_ticketId, options) => failures.push(options),
    );

    mgr.openSession(
      adapter,
      1,
      '/wt/a',
      undefined,
      'seed',
      undefined,
      undefined,
      'sess-stale',
      undefined,
      [],
      { reveal: false, recovery: true },
    );
    closeWithExitCode(terminals[0]!, 1);

    expect(failures).toEqual([{ reveal: false, recovery: true }]);
  });

  it('does not report a resume failure when the resumed session exits cleanly', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const failedResumes: number[] = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      undefined,
      undefined,
      (ticketId) => failedResumes.push(ticketId),
    );

    mgr.openSession(adapter, 1, '/wt/a', undefined, 'seed', undefined, undefined, 'sess-ok');
    closeWithExitCode(terminals[0]!, 0);

    expect(failedResumes).toEqual([]);
  });

  it('does not report a resume failure for a fresh (non-resume) launch', () => {
    const { adapter } = fakeAdapter();
    const { host, terminals } = fakeHost();
    const failedResumes: number[] = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      undefined,
      undefined,
      (ticketId) => failedResumes.push(ticketId),
    );

    mgr.openSession(adapter, 1, '/wt/a', undefined, 'seed');
    closeWithExitCode(terminals[0]!, 1);

    expect(failedResumes).toEqual([]);
  });

  it('does not report a resume failure for an adopted restored terminal', () => {
    const restored = fakeRestored(7);
    const { host } = fakeHost([restored]);
    const failedResumes: number[] = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      undefined,
      undefined,
      (ticketId) => failedResumes.push(ticketId),
    );

    mgr.reconcileRestoredSessions(() => 'resume');
    restored.terminal.disposeHandler?.(1);

    expect(failedResumes).toEqual([]);
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

  it('invokes onLaunchPrepared for a fresh launch, carrying the allocated launch id', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const prepared: unknown[] = [];
    const mgr = new SessionManager(
      host, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
    );

    mgr.openSession(adapter, 7, '/wt/a');

    expect(prepared).toEqual([{ ticketId: 7, launchId, resume: false, switchLaunch: false, seedTelemetry: { seedChars: 0, guidePointer: false } }]);
  });

  it('an ordinary resume launch records resume: true', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const prepared: unknown[] = [];
    const mgr = new SessionManager(
      host, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
    );

    mgr.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, 'sess-7');

    expect(prepared).toEqual([{ ticketId: 7, launchId, resume: true, switchLaunch: false, seedTelemetry: { seedChars: 4, guidePointer: false } }]);
  });

  it('an agent switch launch records switchLaunch: true', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const prepared: unknown[] = [];
    const mgr = new SessionManager(
      host, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
    );

    mgr.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined,
      undefined, [], { allowResume: false, providerReady: true });

    expect(prepared).toEqual([{ ticketId: 7, launchId, resume: false, switchLaunch: true, seedTelemetry: { seedChars: 0, guidePointer: false } }]);
  });

  it('focusing an existing terminal invokes no launch callback', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const prepared: unknown[] = [];
    const mgr = new SessionManager(
      host, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
    );

    mgr.openSession(adapter, 7, '/wt/a');
    mgr.openSession(adapter, 7, '/wt/a');

    expect(prepared).toHaveLength(1);
  });

  // Task 3: the host-only Fix assignment rides the prepared launch so the
  // eventual fix launch intent can be recorded with the CONFIGURED identity —
  // never re-resolved from live configuration after the launch is prepared.
  it('forwards the host-only assignment override into the prepared-launch info', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const prepared: unknown[] = [];
    const mgr = new SessionManager(
      host, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
    );

    mgr.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined,
      undefined, [], { assignment: { agentName: 'UAT Fix Agent', provider: 'codex', model: 'sol' } });

    expect(prepared).toEqual([{
      ticketId: 7,
      launchId,
      resume: false,
      switchLaunch: false,
      assignment: { agentName: 'UAT Fix Agent', provider: 'codex', model: 'sol' },
      seedTelemetry: { seedChars: 0, guidePointer: false },
    }]);
  });

  it('carries no assignment when the launch options set none', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const prepared: unknown[] = [];
    const mgr = new SessionManager(
      host, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
    );

    mgr.openSession(adapter, 7, '/wt/a');

    expect(prepared).toEqual([{ ticketId: 7, launchId, resume: false, switchLaunch: false, seedTelemetry: { seedChars: 0, guidePointer: false } }]);
  });

  it('records the session identity snapshot and returns it on demand', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(
      adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined,
      undefined, [], {}, { provider: 'codex', model: 'sol' },
    );

    expect(mgr.sessionIdentity(7)).toEqual({ provider: 'codex', model: 'sol' });
    expect(mgr.sessionIdentity(99)).toBeNull();
  });

  it('carries the configured agent name in the recorded identity snapshot', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(
      adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined,
      undefined, [], {}, { provider: 'codex', model: 'sol', agentName: 'UAT Fix Agent' },
    );

    expect(mgr.sessionIdentity(7)).toEqual({
      provider: 'codex',
      model: 'sol',
      agentName: 'UAT Fix Agent',
    });
  });

  it('no identity is recorded when none was supplied at launch', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 7, '/wt/a');

    expect(mgr.sessionIdentity(7)).toBeNull();
  });

  it('reports a ticket live only while its terminal is open', () => {
    const { adapter } = fakeAdapter();
    const { host } = fakeHost();
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.isLive(7)).toBe(false);
    mgr.openSession(adapter, 7, '/wt/a');
    expect(mgr.isLive(7)).toBe(true);
  });

  it('reports a revived handle live, adopting it without revealing it', () => {
    const restored = fakeRestored(7);
    const { host } = fakeHost([restored]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.isLive(7)).toBe(true);
    expect(mgr.isOpen(7)).toBe(true);
    // An automated continuation must not yank the user out of what they are doing.
    expect(restored.terminal.shown).toBe(0);
    // The adopted handle carries no recorded identity — the caller falls back.
    expect(mgr.sessionIdentity(7)).toBeNull();
  });

  it('restores a revived terminal\'s durable session identity when the host recovered it', () => {
    const restored = Object.assign(fakeRestored(7), {
      identity: { provider: 'codex', model: 'sol' },
    });
    const { host } = fakeHost([restored]);
    const mgr = new SessionManager(host, channelFor);

    expect(mgr.isLive(7)).toBe(true);
    expect(mgr.sessionIdentity(7)).toEqual({ provider: 'codex', model: 'sol' });
  });

  it('adopting a revived terminal invokes no launch callback', () => {
    const restored = fakeRestored(7);
    const { host } = fakeHost([restored]);
    const prepared: unknown[] = [];
    const mgr = new SessionManager(
      host, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
    );

    mgr.openSession(fakeAdapter().adapter, 7, '/wt/a');

    expect(prepared).toHaveLength(0);
    expect(mgr.isOpen(7)).toBe(true);
  });

  it('terminal creation failure invokes onLaunchFailed with the launch id and rethrows', () => {
    const { adapter } = fakeAdapter();
    const failingHost: TerminalHost = {
      createTerminal: () => {
        throw new Error('spawn failed');
      },
    };
    const prepared: unknown[] = [];
    const failed: string[] = [];
    const mgr = new SessionManager(
      failingHost, channelFor, undefined, undefined, undefined, undefined, undefined,
      (info) => prepared.push(info),
      (launchId) => failed.push(launchId),
    );

    expect(() => mgr.openSession(adapter, 7, '/wt/a')).toThrow('spawn failed');
    expect(prepared).toHaveLength(1);
    expect(failed).toEqual([launchId]);
  });
});

describe('ticketIdFromTerminalEnv', () => {
  it('reads the ticket a terminal was launched for', () => {
    expect(ticketIdFromTerminalEnv({ [KARST_TICKET_ENV]: '42' })).toBe(42);
  });

  it('has no answer for a terminal karst did not launch', () => {
    // Every terminal in the window — the user's own shells included — reaches
    // this helper. Anything but a Karst launch must resolve to nothing.
    expect(ticketIdFromTerminalEnv(undefined)).toBeUndefined();
    expect(ticketIdFromTerminalEnv({})).toBeUndefined();
    expect(ticketIdFromTerminalEnv({ [KARST_TICKET_ENV]: undefined })).toBeUndefined();
  });

  it('refuses anything that is not a positive integer id', () => {
    // The value comes back out of the host's own environment record, so it is
    // typed as a string but never validated. `Number('')` is 0 and `Number(' 1')`
    // is 1 — both would silently address the wrong ticket, or none.
    for (const raw of ['', '0', '-1', '1.5', ' 1', '1abc', 'abc']) {
      expect(ticketIdFromTerminalEnv({ [KARST_TICKET_ENV]: raw })).toBeUndefined();
    }
  });
});
