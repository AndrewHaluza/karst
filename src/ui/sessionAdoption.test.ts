import { describe, expect, it } from 'vitest';
import {
  SessionManager,
  type RestoredSession,
  type SessionTerminal,
  type TerminalHost,
} from './session.js';
import {
  recoverSession,
  recoveryOutcomeDisposition,
  SessionRecoveryLifecycle,
} from './sessionRecovery.js';
import type { AgentAdapter } from '../agent/adapter.js';

interface RecordedTerminal extends SessionTerminal {
  shown: number;
  disposed: boolean;
  closeHandler?: (exitCode?: number) => void;
}

function recordedTerminal(): RecordedTerminal {
  const terminal: RecordedTerminal = {
    shown: 0,
    disposed: false,
    show: () => {
      terminal.shown++;
    },
    sendText: () => {},
    dispose: () => {
      terminal.disposed = true;
      terminal.closeHandler?.();
    },
    onDidClose: (handler) => {
      terminal.closeHandler = handler;
    },
  };
  return terminal;
}

function restoredSession(
  ticketId: number,
  launchId?: string,
  exited?: boolean,
): RestoredSession & { terminal: RecordedTerminal } {
  return {
    ticketId,
    ...(launchId ? { launchId } : {}),
    ...(exited ? { exited } : {}),
    terminal: recordedTerminal(),
  };
}

/** A host whose restored list is the source of late-revived terminals. */
function hostWith(restored: RestoredSession[]): {
  host: TerminalHost;
  created: RecordedTerminal[];
} {
  const created: RecordedTerminal[] = [];
  return {
    created,
    host: {
      createTerminal: () => {
        const terminal = recordedTerminal();
        created.push(terminal);
        return terminal;
      },
      restoredSessions: () => restored,
    },
  };
}

const adapter: AgentAdapter = {
  buildInteractiveCommand: () => ({ command: 'agent', args: [], env: {} }),
  runHeadless: () => Promise.reject(new Error('not used')),
  requiredBinary: 'agent',
  capabilities: { lifecycleEvents: true, resume: true },
};

const channelFor = () => ({
  endpointUrl: 'http://127.0.0.1:4567/hooks',
  configDir: '/runtime',
  launchId: 'fresh-launch',
});

describe('adopting terminals VS Code revives after the activation scan', () => {
  it('adopts a late-revived terminal instead of launching a second agent', () => {
    const restored = restoredSession(7, 'old-launch');
    const { host, created } = hostWith([restored]);
    const adopted: Array<[number, string | undefined]> = [];
    const mgr = new SessionManager(
      host,
      () => {
        throw new Error('adoption must not allocate a launch generation');
      },
      undefined,
      undefined,
      undefined,
      (ticketId, launchId) => adopted.push([ticketId, launchId]),
    );

    mgr.openSession(adapter, 7, '/wt/a');

    expect(created).toHaveLength(0);
    expect(mgr.isOpen(7)).toBe(true);
    expect(restored.terminal.shown).toBe(1);
    expect(restored.terminal.disposed).toBe(false);
    expect(adopted).toEqual([[7, 'old-launch']]);
  });

  it('launches fresh when the only restored terminal is a dead process', () => {
    const restored = restoredSession(7, 'old-launch', true);
    const { host, created } = hostWith([restored]);
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 7, '/wt/a');

    expect(created).toHaveLength(1);
    expect(restored.terminal.shown).toBe(0);
  });

  it('leaves other tickets alone when adopting for one', () => {
    const other = restoredSession(9, 'other-launch');
    const { host, created } = hostWith([other]);
    const mgr = new SessionManager(host, channelFor);

    mgr.openSession(adapter, 7, '/wt/a');

    expect(created).toHaveLength(1);
    expect(other.terminal.shown).toBe(0);
    expect(mgr.isOpen(9)).toBe(false);
  });

  it('disposes and retires a late arrival for a ticket already running here', () => {
    const { host } = hostWith([]);
    const closed: Array<[number, string | undefined]> = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      (ticketId, launchId) => closed.push([ticketId, launchId]),
    );
    mgr.openSession(adapter, 7, '/wt/a');
    const late = restoredSession(7, 'old-launch');

    expect(mgr.adoptLateSession(late, () => 'resume')).toEqual({
      kind: 'duplicate',
    });
    expect(late.terminal.disposed).toBe(true);
    expect(closed).toEqual([[7, 'old-launch']]);
    expect(mgr.isOpen(7)).toBe(true);
  });

  it('ignores the open event for the terminal it just created', () => {
    const { host } = hostWith([]);
    const closed: Array<[number, string | undefined]> = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      (ticketId, launchId) => closed.push([ticketId, launchId]),
    );
    mgr.openSession(adapter, 7, '/wt/a');
    const own = restoredSession(7, 'fresh-launch');

    expect(mgr.adoptLateSession(own, () => 'resume')).toEqual({ kind: 'known' });
    expect(own.terminal.disposed).toBe(false);
    expect(closed).toEqual([]);
  });

  it('adopts a late arrival for an untracked ticket with its disposition', () => {
    const { host } = hostWith([]);
    const adopted: Array<[number, string | undefined]> = [];
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      undefined,
      (ticketId, launchId) => adopted.push([ticketId, launchId]),
    );
    const late = restoredSession(7, 'old-launch');

    expect(mgr.adoptLateSession(late, () => 'idle')).toEqual({
      kind: 'adopted',
      disposition: 'idle',
    });
    expect(mgr.isOpen(7)).toBe(true);
    expect(adopted).toEqual([[7, 'old-launch']]);
  });

  it('never touches a terminal belonging to another project', () => {
    const { host } = hostWith([]);
    const mgr = new SessionManager(host, channelFor);
    const late = restoredSession(7, 'old-launch');

    expect(mgr.adoptLateSession(late, () => 'ignore')).toEqual({
      kind: 'ignored',
    });
    expect(late.terminal.disposed).toBe(false);
    expect(mgr.isOpen(7)).toBe(false);
  });

  it('does not adopt a late arrival whose process already exited', () => {
    const { host } = hostWith([]);
    const mgr = new SessionManager(host, channelFor);
    const late = restoredSession(7, 'old-launch', true);

    expect(mgr.adoptLateSession(late, () => 'resume')).toEqual({
      kind: 'ignored',
    });
    expect(mgr.isOpen(7)).toBe(false);
  });
});

describe('reload whose terminal tab is revived after the activation scan', () => {
  it('recovers onto the revived terminal instead of a second agent', async () => {
    // The scan finds nothing: VS Code has not revived the tab yet.
    const revived: RestoredSession[] = [];
    const created: RecordedTerminal[] = [];
    const host: TerminalHost = {
      createTerminal: () => {
        const terminal = recordedTerminal();
        created.push(terminal);
        return terminal;
      },
      restoredSessions: () => revived,
    };
    const lifecycle = new SessionRecoveryLifecycle(50);
    const mgr = new SessionManager(
      host,
      channelFor,
      undefined,
      undefined,
      (ticketId, launchId) => lifecycle.sessionClosed(ticketId, launchId),
      (ticketId, launchId) => lifecycle.adoptLaunch(ticketId, launchId),
    );
    expect(mgr.reconcileRestoredSessions(() => 'resume')).toEqual({
      resume: [],
      idle: [],
    });

    const late = restoredSession(7, 'old-launch');
    const outcome = await recoverSession(mgr, lifecycle, 7, (ticketId) => {
      // The tab lands between the scan and the replacement launch.
      revived.push(late);
      mgr.openSession(adapter, ticketId, '/wt/a');
      return Promise.resolve();
    });

    expect(outcome).toEqual({ kind: 'adopted' });
    expect(recoveryOutcomeDisposition(outcome)).toBe('ready');
    expect(created).toHaveLength(0);
    expect(late.terminal.disposed).toBe(false);
    expect(mgr.isOpen(7)).toBe(true);
  });
});

describe('recovery superseded by an adopted terminal', () => {
  it('reports adopted and keeps the adopted terminal alive', async () => {
    const lifecycle = new SessionRecoveryLifecycle(50);
    let disposed = false;
    const sessions = {
      isOpen: () => true,
      disposeSession: () => {
        disposed = true;
      },
    };

    const outcome = await recoverSession(sessions, lifecycle, 7, () => {
      // The revived terminal reaches the manager while the replacement is
      // still being opened; adoption supersedes this recovery attempt.
      lifecycle.adoptLaunch(7, 'old-launch');
      return Promise.resolve();
    });

    expect(outcome).toEqual({ kind: 'adopted' });
    expect(disposed).toBe(false);
    expect(recoveryOutcomeDisposition(outcome)).toBe('ready');
  });
});
