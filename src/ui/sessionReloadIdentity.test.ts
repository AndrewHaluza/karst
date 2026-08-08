import { describe, expect, it } from 'vitest';
import {
  KARST_LAUNCH_ENV,
  SessionManager,
  ticketIdFromTerminalEnv,
  type CreateTerminalOpts,
  type FakeTerminal,
  type RestoredSession,
  type SessionIdentity,
  type TerminalHost,
} from './session.js';
import { planSessionRecovery, type RecoveryCandidate } from './sessionRecovery.js';
import {
  identifyTerminal,
  rememberSessionTerminal,
  type SessionTerminalRecord,
} from './terminalIdentity.js';
import type { AgentAdapter } from '../agent/adapter.js';

const adapter: AgentAdapter = {
  buildInteractiveCommand: () => ({ command: 'agent', args: [], env: {} }),
  runHeadless: () => Promise.reject(new Error('not used')),
  requiredBinary: 'agent',
  capabilities: { lifecycleEvents: true, resume: true },
};

/**
 * A terminal as the WINDOW sees it, which is not what the launching code passed
 * in: VS Code revives a persisted terminal by reattaching to its process, and
 * the handle it hands the extension host is rebuilt from that process alone —
 * the pty keeps running under the same pid and `creationOptions.env` is gone
 * entirely. A fixture that carried the env across a reload is the reason this
 * bug shipped twice, so `reload()` below drops it exactly the way the host does.
 */
interface WindowTerminal {
  name: string;
  pid: number;
  env?: Record<string, string>;
  identity?: SessionIdentity;
  handle: FakeTerminal;
}

function fakeTerminal(): FakeTerminal {
  const terminal: FakeTerminal = {
    name: '',
    cwd: '',
    shellPath: '',
    shellArgs: [],
    env: {},
    shown: 0,
    shownPreserveFocus: [],
    sent: [],
    disposed: false,
    show: (preserveFocus) => {
      terminal.shown++;
      terminal.shownPreserveFocus.push(preserveFocus);
    },
    sendText: (text) => terminal.sent.push(text),
    dispose: () => {
      terminal.disposed = true;
      terminal.disposeHandler?.();
    },
    onDidClose: (handler) => {
      terminal.disposeHandler = handler;
    },
  };
  return terminal;
}

/** The window: terminals plus the pid registry, mirroring `makeTerminalHost`. */
class FakeWindow {
  readonly terminals: WindowTerminal[] = [];
  records: SessionTerminalRecord[] = [];
  private nextPid = 4100;

  host(): TerminalHost {
    return {
      createTerminal: (opts: CreateTerminalOpts) => {
        const name = opts.description ? `${opts.name} — ${opts.description}` : opts.name;
        const handle = fakeTerminal();
        handle.name = name;
        const pid = this.nextPid++;
        const sessionIdentity = opts.identity;
        this.terminals.push({
          name,
          pid,
          env: { ...opts.env },
          ...(sessionIdentity ? { identity: sessionIdentity } : {}),
          handle,
        });
        const ticketId = ticketIdFromTerminalEnv(opts.env);
        if (ticketId !== undefined) {
          const launchId = opts.env[KARST_LAUNCH_ENV];
          this.records = rememberSessionTerminal(this.records, {
            ticketId,
            pid,
            ...(launchId ? { launchId } : {}),
            ...(sessionIdentity ? { identity: sessionIdentity } : {}),
          });
        }
        return handle;
      },
      restoredSessions: (): RestoredSession[] =>
        this.terminals.flatMap((terminal) => {
          const identity = identifyTerminal(
            { env: terminal.env, pid: terminal.pid },
            this.records,
          );
          if (!identity) return [];
          return [
            {
              ticketId: identity.ticketId,
              ...(identity.launchId !== undefined ? { launchId: identity.launchId } : {}),
              ...(identity.identity
                ? { identity: identity.identity }
                : {}),
              terminal: terminal.handle,
            },
          ];
        }),
    };
  }

  /** What the extension host is handed after the window reloads. */
  reload(): void {
    for (const terminal of this.terminals) delete terminal.env;
  }
}

function channelFor(launchId: string) {
  return () => ({
    endpointUrl: 'http://127.0.0.1:4567/hooks',
    configDir: '/runtime',
    launchId,
  });
}

const candidate = (id: number): RecoveryCandidate => ({
  id,
  agentState: 'running',
  canResume: true,
  hasWorktree: true,
});

describe('sessions that are still running after an IDE reload', () => {
  it('adopts them by launch pid instead of launching a second agent', () => {
    const win = new FakeWindow();
    const before = new SessionManager(win.host(), channelFor('launch-7'));
    before.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined, {
      name: 'Karst: ABC-1',
    }, [], {}, { provider: 'codex', model: 'codex-x' });
    expect(win.terminals).toHaveLength(1);

    win.reload();

    // A fresh extension host: new manager, same window, same live agent.
    const adoptedLaunches: Array<[number, string | undefined]> = [];
    const after = new SessionManager(
      win.host(),
      channelFor('launch-next'),
      undefined,
      undefined,
      undefined,
      (ticketId, launchId) => adoptedLaunches.push([ticketId, launchId]),
    );

    const adopted = after.reconcileRestoredSessions(() => 'resume');

    expect(adopted).toEqual({ resume: [7], idle: [] });
    expect(after.isOpen(7)).toBe(true);
    expect(after.sessionIdentity(7)).toEqual({ provider: 'codex', model: 'codex-x' });
    // The generation comes back with it, so the surviving agent's hooks are
    // still recognized as this ticket's current session.
    expect(adoptedLaunches).toEqual([[7, 'launch-7']]);
    // Nothing left for background recovery to relaunch.
    expect(planSessionRecovery([candidate(7)], [7], adopted)).toEqual({
      resume: [],
      idle: [],
      discard: [],
    });
    expect(win.terminals).toHaveLength(1);
  });

  it('opens onto the surviving terminal rather than a duplicate', () => {
    const win = new FakeWindow();
    const before = new SessionManager(win.host(), channelFor('launch-7'));
    before.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined, {
      name: 'Karst: ABC-1',
    });
    win.reload();

    const after = new SessionManager(win.host(), channelFor('launch-next'));
    // The tab is revived AFTER the activation scan, so the open path is what has
    // to recognize it — the case background recovery hits.
    after.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined, {
      name: 'Karst: ABC-1',
    });

    expect(win.terminals).toHaveLength(1);
    expect(win.terminals[0]!.handle.disposed).toBe(false);
    expect(after.isOpen(7)).toBe(true);
  });

  it('will not adopt a terminal this window never launched', () => {
    // The pid registry is the evidence. Without it a revived tab is just a
    // terminal, and adopting one would hand a stranger the ticket's prompts.
    const win = new FakeWindow();
    const before = new SessionManager(win.host(), channelFor('launch-7'));
    before.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined, {
      name: 'Karst: ABC-1',
    });
    win.reload();
    win.records = [];

    const after = new SessionManager(win.host(), channelFor('launch-next'));

    expect(after.reconcileRestoredSessions(() => 'resume')).toEqual({
      resume: [],
      idle: [],
    });
    expect(after.isOpen(7)).toBe(false);
  });
});
