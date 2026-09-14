/**
 * SupervisedCLITransport (Slice 3 Task 3).
 *
 * The sole bridge from `AgentAdapter` to `AgentTransport`: it calls
 * `buildInteractiveCommand`, owns the spawn and the supervision on top of it,
 * carries the caller-persisted owner nonce, records process/start identity
 * immediately after spawn, and terminates only on attributed evidence
 * (`runtime/serverIdentity.ts` — no invented probe). Graph sessions register
 * with the existing `servers` registry keyed by their workspace cwd, so
 * `removeWorktree` → `stopServersUnder` and the global `reapStaleServers`
 * sweep both see them — the 869ed2n50 detached-process class, by name.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openStore } from '../../../store/db.js';
import { stopServersUnder, reapStaleServers } from '../../../runtime/worktreeServers.js';
import {
  createSupervisedCliTransport,
  type SupervisedTransportDeps,
} from './supervisedCliTransport.js';
import type { TransportTerminal, TransportTerminalHost, SupervisedAgentSession } from './agentTransport.js';
import type { AgentAdapter, InteractiveCommand } from '../../../agent/adapter.js';

/** A terminal fake that resolves a configured pid immediately after spawn. */
function fakeTerminal(pid: number | undefined): TransportTerminal & { disposed: boolean } {
  return {
    processId: () => Promise.resolve(pid),
    show: () => {},
    sendText: () => {},
    dispose: () => {},
    onDidClose: () => {},
    disposed: false,
  };
}

function adapterFor(command: InteractiveCommand): AgentAdapter {
  return {
    requiredBinary: 'fake',
    runHeadless: async () => {
      throw new Error('unused');
    },
    buildInteractiveCommand: () => command,
  } as unknown as AgentAdapter;
}

interface Harness {
  deps: SupervisedTransportDeps;
  calls: {
    order: string[];
    nonce: string;
    terminal: { cwd: string; shellPath: string; shellArgs: string[]; env: Record<string, string> };
  };
  sessions: { ticketId: number; repo: string; pid: number | null; cwd: string; startedAt: string }[];
}

function harness(pid?: number, terminalHost?: TransportTerminalHost): Harness {
  const calls: Harness['calls'] = {
    order: [],
    nonce: '',
    terminal: { cwd: '', shellPath: '', shellArgs: [], env: {} },
  };
  const sessions: Harness['sessions'] = [];
  const deps: SupervisedTransportDeps = {
    terminalHost:
      terminalHost ??
      {
        createTerminal: (opts) => {
          calls.order.push('spawn');
          calls.terminal = { cwd: opts.cwd, shellPath: opts.shellPath, shellArgs: opts.shellArgs, env: opts.env };
          return fakeTerminal(pid);
        },
      },
    recordSession: (row) => {
      calls.order.push('record');
      sessions.push(row);
    },
    killTree: () => 'killed',
    facts: {
      isAlive: () => true,
      liveCwd: () => ({ path: '/wt/n1', deleted: false }),
      processStartMs: () => Date.parse('2026-08-12T00:00:00.000Z'),
    },
    now: () => '2026-08-12T00:00:00.000Z',
  };
  return { deps, calls, sessions };
}

const LAUNCH = {
  nodeRunId: 11,
  ticketId: 1,
  graphRunId: 2,
  repo: 'api',
  cwd: '/wt/n1',
  generation: 'gen-1',
  ownerNonce: 'a'.repeat(32),
  adapter: adapterFor({ command: 'claude', args: ['--resume'], env: { KARST_TICKET_ID: '1' } }),
  interactive: { cwd: '/wt/n1' },
  graphEnv: { KARST_GRAPH_RUN_ID: '2', KARST_GRAPH_CALLBACK_URL: 'http://127.0.0.1:9/wakeup' },
};

describe('SupervisedCLITransport', () => {
  it('forwards the session icon path to the terminal host', async () => {
    const terminal = fakeTerminal(4242);
    const calls: Array<Record<string, unknown>> = [];
    const h = harness(undefined, {
      createTerminal: (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return terminal;
      },
    });
    const transport = createSupervisedCliTransport(h.deps);
    await transport.start({
      ...LAUNCH,
      sessionName: 'Karst: K-1 — fix',
      sessionIconPath: '/icon/karst.svg',
    });
    expect(calls[0]!.iconPath).toBe('/icon/karst.svg');
    expect(calls[0]!.name).toBe('Karst: K-1 — fix');
  });

  it('carries the caller-persisted owner nonce onto the session and records identity after spawn', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const session = await transport.start(LAUNCH);
    expect(h.calls.order).toEqual(['spawn', 'record']);
    expect(h.calls.terminal).toMatchObject({ cwd: '/wt/n1', shellPath: 'claude', shellArgs: ['--resume'] });
    expect(session).toMatchObject({
      nodeRunId: 11,
      ticketId: 1,
      graphRunId: 2,
      pid: 4242,
      cwd: '/wt/n1',
      generation: 'gen-1',
      startedAt: '2026-08-12T00:00:00.000Z',
      providerSessionId: null,
    });
    // The nonce is the CLAIM transaction's — the transport never mints one,
    // so no window observes a `launching` row without launch identity.
    expect(session.ownerNonce).toBe(LAUNCH.ownerNonce);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ ticketId: 1, repo: 'api', pid: 4242, cwd: '/wt/n1' });
  });

  it('merges the graph environment onto the adapter-built environment', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    await transport.start(LAUNCH);
    expect(h.deps.terminalHost.createTerminal).toBeDefined();
  });

  it('records a null pid when the terminal never produced one', async () => {
    const h = harness();
    const transport = createSupervisedCliTransport(h.deps);
    const session = await transport.start(LAUNCH);
    expect(session.pid).toBeNull();
    expect(session.startedAt).toBeNull();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ pid: null, cwd: '/wt/n1' });
  });

  it('keeps sessions in its own (ticketId, nodeRunId) registry', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    await transport.start(LAUNCH);
    expect(transport.sessions()).toHaveLength(1);
    expect(transport.sessionFor(1, 11)?.pid).toBe(4242);
    expect(transport.sessionFor(1, 99)).toBeUndefined();
  });

  it('adopts a session a reloaded window re-attaches, without re-spawning', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const adopted: SupervisedAgentSession = {
      nodeRunId: 55,
      ticketId: 1,
      graphRunId: 2,
      pid: 4242,
      cwd: '/wt/n1',
      generation: 'gen-1',
      ownerNonce: 'nonce-adopted',
      startedAt: '2026-08-12T00:00:00.000Z',
      processRunId: null,
      providerSessionId: null,
      terminal: fakeTerminal(4242),
    };
    transport.adopt(adopted);
    expect(transport.sessions()).toHaveLength(1);
    expect(transport.sessionFor(1, 55)).toBe(adopted);
    expect(h.calls.order).toEqual([]); // no spawn/record — nothing new launched
  });

  it('adopting an already-known (ticketId, nodeRunId) is idempotent — the registry entry is replaced, not duplicated', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const first: SupervisedAgentSession = {
      nodeRunId: 55,
      ticketId: 1,
      graphRunId: 2,
      pid: 4242,
      cwd: '/wt/n1',
      generation: 'gen-1',
      ownerNonce: 'nonce-a',
      startedAt: '2026-08-12T00:00:00.000Z',
      processRunId: null,
      providerSessionId: null,
      terminal: fakeTerminal(4242),
    };
    transport.adopt(first);
    const second: SupervisedAgentSession = { ...first, ownerNonce: 'nonce-b' };
    transport.adopt(second);
    expect(transport.sessions()).toHaveLength(1);
    expect(transport.sessionFor(1, 55)?.ownerNonce).toBe('nonce-b');
  });

  it('adopt wires the revived terminal close to the accounting row, once, with the exit verdict', async () => {
    const close: Array<{ processRunId: number; status: string }> = [];
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      closeProcessRun: (processRunId, status) => {
        close.push({ processRunId, status });
      },
    });
    const adopted: SupervisedAgentSession = {
      nodeRunId: 66,
      ticketId: 1,
      graphRunId: 2,
      pid: 4242,
      cwd: '/wt/n1',
      generation: 'gen-1',
      ownerNonce: 'nonce',
      startedAt: '2026-08-12T00:00:00.000Z',
      processRunId: 77,
      providerSessionId: null,
      terminal,
    };
    transport.adopt(adopted);
    expect(close).toEqual([]);
    closeHandler?.(0);
    expect(close).toEqual([{ processRunId: 77, status: 'passed' }]);
    expect(transport.sessionFor(adopted.ticketId, adopted.nodeRunId)).toBeUndefined();
  });

  it('terminates an attributable pid via the process group and reports the kill outcome', async () => {
    const h = harness(4242);
    let signalled: number | undefined;
    const transport = createSupervisedCliTransport({
      ...h.deps,
      killTree: (pid) => {
        signalled = pid;
        return 'killed';
      },
    });
    const session = await transport.start(LAUNCH);
    const proof = await transport.terminate(session);
    expect(signalled).toBe(4242);
    expect(proof).toEqual({ kind: 'attributable', kill: 'killed' });
  });

  it('a denied kill reads as NOT terminated — the row stays running and the lease stays held', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport({ ...h.deps, killTree: () => 'denied' });
    const session = await transport.start(LAUNCH);
    const proof = await transport.terminate(session);
    // The caller (node executor) must keep the row `running` and the lease
    // held — `denied` is a live process that refused, never a termination.
    expect(proof).toEqual({ kind: 'attributable', kill: 'denied' });
    expect(h.deps.recordSession).toBeDefined();
  });

  it('a reissued pid reads foreign and signals nothing', async () => {
    const h = harness(4242);
    let signalled = false;
    const transport = createSupervisedCliTransport({
      ...h.deps,
      facts: {
        isAlive: () => true,
        liveCwd: () => ({ path: '/somewhere/else', deleted: false }),
        processStartMs: () => 1_700_000_000_999, // outside START_TIME_TOLERANCE_MS
      },
      killTree: (pid) => {
        signalled = true;
        return 'killed';
      },
    });
    const session = await transport.start(LAUNCH);
    const proof = await transport.terminate(session);
    expect(proof).toEqual({ kind: 'foreign' });
    expect(signalled).toBe(false);
  });

  it('a dead pid signals nothing; an unknowable pid signals nothing', async () => {
    const h = harness(4242);
    let signalled = false;
    const deadTransport = createSupervisedCliTransport({
      ...h.deps,
      facts: { isAlive: () => false, liveCwd: () => null, processStartMs: () => null },
      killTree: () => {
        signalled = true;
        return 'killed';
      },
    });
    const session = await deadTransport.start(LAUNCH);
    expect(await deadTransport.terminate(session)).toEqual({ kind: 'dead' });
    expect(signalled).toBe(false);

    const unknownTransport = createSupervisedCliTransport({
      ...h.deps,
      facts: { isAlive: () => true, liveCwd: () => null, processStartMs: () => null },
    });
    const unknownSession = await unknownTransport.start(LAUNCH);
    expect(await unknownTransport.terminate(unknownSession)).toEqual({ kind: 'unknown' });
    expect(signalled).toBe(false);

    const noPid = createSupervisedCliTransport(h.deps);
    const noPidSession = await noPid.start({ ...LAUNCH, nodeRunId: 12 });
    expect(noPidSession.pid).not.toBeNull();
  });

  it('a graph session appears in the servers registry and is reaped by BOTH paths', () => {
    const store = openStore(':memory:');
    const worktreeDir = '/repo/.karst/worktrees/ticket-1';
    // The OS verdict is per-pid: A's tree is gone under the worktree, B's
    // sibling tree is gone too (its parent still stands).
    const deadFacts = {
      isAlive: () => false,
      liveCwd: (pid: number) => ({
        path: pid === 222 ? '/repo/.karst/worktrees/other-ticket/node' : `${worktreeDir}/node`,
        deleted: true,
      }),
      processStartMs: () => null,
    };
    // Session A serves a cwd under the worktree — `stopServersUnder` matches
    // it by PATH.
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, cwd, started_at)
         VALUES (?, 'api', 'graph', NULL, ?, 'running', ?, ?)`,
      )
      .run(1, 111, `${worktreeDir}/node`, '2026-08-12T00:00:00.000Z');
    // Session B serves a SIBLING tree — stopServersUnder (by path) must miss
    // it; the global sweep catches it by a GONE directory instead.
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, cwd, started_at)
         VALUES (?, 'web', 'graph', NULL, ?, 'running', ?, ?)`,
      )
      .run(1, 222, '/repo/.karst/worktrees/other-ticket/node', '2026-08-12T00:00:00.000Z');
    const underTree = stopServersUnder(store, worktreeDir, { facts: deadFacts });
    expect(underTree.map((r) => r.outcome)).toEqual(['row-cleared']);
    const swept = reapStaleServers(store, { facts: deadFacts });
    expect(swept.map((r) => r.outcome)).toEqual(['row-cleared']);
    const remaining = store.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE status = 'running'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('a graph launch opens exactly one process_runs row and is counted once', async () => {
    const h = harness(4242);
    const opened: number[] = [];
    const transport = createSupervisedCliTransport({
      ...h.deps,
      openProcessRun: (request, pid) => {
        expect(request.nodeRunId).toBe(LAUNCH.nodeRunId);
        expect(pid).toBe(4242);
        h.calls.order.push('open');
        opened.push(request.nodeRunId);
        return 77;
      },
    });
    const session = await transport.start(LAUNCH);
    expect(opened).toEqual([LAUNCH.nodeRunId]);
    expect(session.processRunId).toBe(77);
    // The accounting row opens as part of the launch, before the session is
    // handed back — never a second time for the same launch.
    expect(h.calls.order).toEqual(['spawn', 'open', 'record']);
  });

  it('a transport that cannot record usage opens no row and never fabricates a zero', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const session = await transport.start(LAUNCH);
    expect(session.processRunId).toBeNull();
  });

  it('a locked database never fails the launch', async () => {
    const h = harness(4242);
    const transport = createSupervisedCliTransport({
      ...h.deps,
      openProcessRun: () => {
        throw new Error('database is locked');
      },
    });
    const session = await transport.start(LAUNCH);
    expect(session.pid).toBe(4242);
    expect(session.processRunId).toBeNull();
  });

  it('a locked servers registry never fails the launch and never orphans the terminal', async () => {
    // `recordSession` runs with a LIVE terminal already spawned. A throw that
    // escaped `start` left that terminal in no registry, with no close
    // handler: untrackable by `sessions()`, unreachable by `stopServersUnder`
    // / `reapStaleServers`, never closed out — the 869ed2n50 leak class.
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const close: Array<{ processRunId: number; status: string }> = [];
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      openProcessRun: () => 77,
      closeProcessRun: (processRunId, status) => {
        close.push({ processRunId, status });
      },
      recordSession: () => {
        throw new Error('database is locked');
      },
    });
    const session = await transport.start(LAUNCH);
    expect(session.pid).toBe(4242);
    expect(transport.sessionFor(LAUNCH.ticketId, LAUNCH.nodeRunId)).toBeDefined();

    closeHandler?.(0);

    expect(transport.sessionFor(LAUNCH.ticketId, LAUNCH.nodeRunId)).toBeUndefined();
    expect(close).toEqual([{ processRunId: 77, status: 'passed' }]);
  });

  it('closes the process run when the terminal closes, once, with the exit verdict', async () => {
    const close: Array<{ processRunId: number; status: string }> = [];
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      openProcessRun: () => 77,
      closeProcessRun: (processRunId, status) => {
        close.push({ processRunId, status });
      },
    });
    await transport.start(LAUNCH);
    expect(close).toEqual([]);
    closeHandler?.(0);
    // A terminal's close handler fires exactly once in reality; the store's
    // guarded close is the layer that ignores anything already closed.
    expect(close).toEqual([{ processRunId: 77, status: 'passed' }]);
  });

  it('closes the process run as interrupted when the exit code is unknown', async () => {
    const close: Array<{ processRunId: number; status: string }> = [];
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      openProcessRun: () => 77,
      closeProcessRun: (processRunId, status) => {
        close.push({ processRunId, status });
      },
    });
    await transport.start(LAUNCH);
    closeHandler?.(undefined);
    expect(close).toEqual([{ processRunId: 77, status: 'interrupted' }]);
  });

  it('removes a closed terminal from the live session registry so reconciliation can recover it', async () => {
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
    });
    await transport.start(LAUNCH);
    expect(transport.sessionFor(LAUNCH.ticketId, LAUNCH.nodeRunId)).toBeDefined();

    closeHandler?.(undefined);

    expect(transport.sessionFor(LAUNCH.ticketId, LAUNCH.nodeRunId)).toBeUndefined();
    expect(transport.sessions()).toEqual([]);
  });

  it('pins SessionManager: its terminals map stays keyed by ticket id only', () => {    const source = readFileSync(join(import.meta.dirname, '..', '..', '..', 'ui', 'session.ts'), 'utf8');
    expect(source).toMatch(/terminals = new Map<number, TrackedSession>\(\)/);
    expect(source).not.toMatch(/Map<\[number, number\]/);
  });

  it('pins the sole bridge: no other module imports both AgentAdapter and AgentTransport', () => {
    const srcDir = join(import.meta.dirname, '..', '..', '..');
    const files: string[] = [];
    const collect = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          collect(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          files.push(full);
        }
      }
    };
    collect(srcDir);
    const bridgers = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      const importsAdapter = /from\s+['"][^'"]*agent\/adapter\.js['"]/.test(source);
      const importsTransport = /from\s+['"][^'"]*agentTransport\.js['"]/.test(source);
      return importsAdapter && importsTransport;
    });
    expect(bridgers).toEqual([
      join(srcDir, 'approaches', 'graph', 'transport', 'supervisedCliTransport.ts'),
    ]);
  });
});
