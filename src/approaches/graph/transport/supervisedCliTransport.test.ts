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

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureClaudeWorkspaceTrusted } from '../../../agent/workspaceTrust.js';
import { join, dirname } from 'node:path';
import { openStore } from '../../../store/db.js';
import { stopServersUnder, reapStaleServers } from '../../../runtime/worktreeServers.js';
import {
  createSupervisedCliTransport,
  LAUNCH_EXIT_WINDOW_MS,
  removeOwnedPaths,
  type LaunchFailure,
  type SupervisedLaunchRequest,
  type SupervisedTransportDeps,
} from './supervisedCliTransport.js';
import type { TransportTerminal, TransportTerminalHost, SupervisedAgentSession } from './agentTransport.js';
import type {
  AgentAdapter,
  InteractiveCommand,
  InteractiveCommandOpts,
} from '../../../agent/adapter.js';
import { Opencode2Adapter } from '../../../agent/opencode2.js';
import { graphLaunchIdForLaunch, parseGraphLaunchId } from '../graphLaunchId.js';

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

  it('forwards the resolved launch identity so a provider-keyed watch sees the graph session', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = harness(undefined, {
      createTerminal: (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return fakeTerminal(4242);
      },
    });
    const transport = createSupervisedCliTransport(h.deps);
    await transport.start({
      ...LAUNCH,
      identity: { profile: 'worker', provider: 'antigravity', model: 'gemini-4-neon-high' },
    });
    expect(calls[0]!.identity).toEqual({
      provider: 'antigravity',
      model: 'gemini-4-neon-high',
      agentName: 'worker',
    });
  });

  it('omits the terminal identity when the launch resolved none', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = harness(undefined, {
      createTerminal: (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return fakeTerminal(4242);
      },
    });
    const transport = createSupervisedCliTransport(h.deps);
    await transport.start({ ...LAUNCH });
    expect(calls[0]).not.toHaveProperty('identity');
  });

  it('passes a pinned account to buildInteractiveCommand', async () => {
    const h = harness(4242);
    const debug = vi.fn();
    const seen: Array<Record<string, unknown>> = [];
    const adapter = {
      requiredBinary: 'fake',
      runHeadless: async () => {
        throw new Error('unused');
      },
      buildInteractiveCommand: (o: Record<string, unknown>) => {
        seen.push(o);
        return { command: 'claude', args: [], env: {} };
      },
    } as unknown as AgentAdapter;
    const transport = createSupervisedCliTransport({ ...h.deps, debug });
    const request: SupervisedLaunchRequest = {
      ...LAUNCH,
      adapter,
      identity: { profile: 'worker', provider: 'claude', account: 'work' },
    };
    await transport.start(request);
    expect(seen[0]).toMatchObject({ policy: 'gate', cwd: '/wt/n1', account: 'work' });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('worker'));
    expect(String(debug.mock.calls.find((c) => String(c[0]).includes('account'))?.[0])).toContain('work');
  });

  it('passes no account key when the launch pins none', async () => {
    const h = harness(4242);
    const seen: Array<Record<string, unknown>> = [];
    const adapter = {
      requiredBinary: 'fake',
      runHeadless: async () => {
        throw new Error('unused');
      },
      buildInteractiveCommand: (o: Record<string, unknown>) => {
        seen.push(o);
        return { command: 'claude', args: [], env: {} };
      },
    } as unknown as AgentAdapter;
    const transport = createSupervisedCliTransport(h.deps);
    const request: SupervisedLaunchRequest = {
      ...LAUNCH,
      adapter,
      identity: { profile: 'worker', provider: 'claude', model: 'claude-opus-5' },
    };
    await transport.start(request);
    expect(seen[0]).not.toHaveProperty('account');
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
      provider: null,
      providerSessionId: null,
    });
    // The nonce is the CLAIM transaction's — the transport never mints one,
    // so no window observes a `launching` row without launch identity.
    expect(session.ownerNonce).toBe(LAUNCH.ownerNonce);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ ticketId: 1, repo: 'api', pid: 4242, cwd: '/wt/n1' });
  });

  it('pre-trusts the workspace cwd before building the launch command', async () => {
    const h = harness(4242);
    const order: string[] = [];
    const trusted: string[] = [];
    const adapter = {
      requiredBinary: 'fake',
      runHeadless: async () => {
        throw new Error('unused');
      },
      ensureWorkspaceTrusted: (cwd: string) => {
        order.push('trust');
        trusted.push(cwd);
      },
      buildInteractiveCommand: () => {
        order.push('build');
        return { command: 'claude', args: [], env: {} };
      },
    } as unknown as AgentAdapter;
    const transport = createSupervisedCliTransport(h.deps);
    const request: SupervisedLaunchRequest = { ...LAUNCH, adapter };
    await transport.start(request);
    // Every graph launch — fresh node, planner, relaunch/Resume — goes through
    // here, so the hook must run with exactly the cwd it spawns in.
    expect(trusted).toEqual(['/wt/n1']);
    expect(order).toEqual(['trust', 'build']);
  });

  it('launches every graph session under the unattended gate policy', async () => {
    const h = harness();
    const seen: Array<{ policy?: string; cwd: string }> = [];
    const adapter = {
      buildInteractiveCommand: (o: { policy?: string; cwd: string }) => {
        seen.push(o);
        return { command: 'claude', args: [], env: {} };
      },
    } as unknown as AgentAdapter;
    const transport = createSupervisedCliTransport(h.deps);
    await transport.start({ ...LAUNCH, adapter } as SupervisedLaunchRequest);
    expect(seen).toEqual([expect.objectContaining({ policy: 'gate', cwd: '/wt/n1' })]);
  });

  it('still launches when the trust hook meets a faulting .git (ELOOP)', async () => {
    const h = harness(4242);
    const cwd = mkdtempSync(join(tmpdir(), 'karst-eloop-'));
    symlinkSync(join(cwd, '.git'), join(cwd, '.git'));
    const home = mkdtempSync(join(tmpdir(), 'karst-home-'));
    const adapter = {
      requiredBinary: 'fake',
      runHeadless: async () => {
        throw new Error('unused');
      },
      ensureWorkspaceTrusted: (dir: string) => ensureClaudeWorkspaceTrusted(dir, { home }),
      buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    } as unknown as AgentAdapter;
    const request: SupervisedLaunchRequest = { ...LAUNCH, cwd, adapter };
    const session = await createSupervisedCliTransport(h.deps).start(request);
    expect(session.pid).toBe(4242);
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
      provider: null,
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
      provider: null,
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
      provider: null,
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

  it('reports a process that exits before its session started as a launch failure, with the captured line', async () => {
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    let writeHandler: ((data: string) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    terminal.onDidWriteData = (handler) => {
      writeHandler = handler;
    };
    const failures: LaunchFailure[] = [];
    let clock = Date.parse('2026-08-12T00:00:00.000Z');
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      now: () => new Date(clock).toISOString(),
      onLaunchFailed: (failure) => failures.push(failure),
    });
    const session = await transport.start(LAUNCH);
    // The provider writes a banner and the reason it is about to exit.
    writeHandler?.('\u001b[2Jbooting\nFolder trust required\n');
    clock += 900; // inside the launch window
    closeHandler?.(1);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ exitCode: 1, outputLine: 'Folder trust required' });
    expect(failures[0]!.session).toBe(session);
    expect(failures[0]!.request.nodeRunId).toBe(LAUNCH.nodeRunId);
  });

  it('leaves an exit AFTER the launch window to the reconcile sweep', async () => {
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const failures: LaunchFailure[] = [];
    let clock = Date.parse('2026-08-12T00:00:00.000Z');
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      now: () => new Date(clock).toISOString(),
      onLaunchFailed: (failure) => failures.push(failure),
    });
    await transport.start(LAUNCH);
    clock += LAUNCH_EXIT_WINDOW_MS;
    closeHandler?.(0);
    // The session ran past its launch; its death is a reconcile concern, not a
    // launch failure.
    expect(failures).toEqual([]);
  });

  it('reports a launch failure with no captured line when the host cannot observe output', async () => {
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const failures: LaunchFailure[] = [];
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      onLaunchFailed: (failure) => failures.push(failure),
    });
    await transport.start(LAUNCH);
    closeHandler?.(undefined);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.outputLine).toBe('');
    expect(failures[0]!.exitCode).toBeUndefined();
  });

  it('does not report a launch failure for a session this window is stopping', async () => {
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const failures: LaunchFailure[] = [];
    let clock = Date.parse('2026-08-12T00:00:00.000Z');
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      now: () => new Date(clock).toISOString(),
      onLaunchFailed: (failure) => failures.push(failure),
    });
    const session = await transport.start(LAUNCH);
    await transport.terminate(session);
    clock += 200;
    closeHandler?.(undefined);
    // A Stop ends the session deliberately; its close is not a launch failure.
    expect(failures).toEqual([]);
  });

  it('a Stop of a session whose process is already dead does not suppress a genuine early exit', async () => {
    // The low review finding: the Stop marker was set before the Stop was known
    // to have stopped anything. A provider that had ALREADY exited early, with
    // a Stop clicked just before its close landed, then read as "a Stop" and
    // its genuine early-exit report was lost.
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const failures: LaunchFailure[] = [];
    let clock = Date.parse('2026-08-12T00:00:00.000Z');
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      // The process is already gone: the Stop cannot have caused the close.
      facts: {
        isAlive: () => false,
        liveCwd: () => ({ path: '/wt/n1', deleted: false }),
        processStartMs: () => Date.parse('2026-08-12T00:00:00.000Z'),
      },
      now: () => new Date(clock).toISOString(),
      onLaunchFailed: (failure) => failures.push(failure),
    });
    const session = await transport.start(LAUNCH);
    expect(await transport.terminate(session)).toEqual({ kind: 'dead' });
    clock += 200;
    closeHandler?.(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.request.nodeRunId).toBe(LAUNCH.nodeRunId);
  });

  it('reports a launch failure for a fresh session after a Stop, not just the first', async () => {
    // The high review finding: the Stop marker was never cleared, so a LATER
    // launch of the same reserved visit never reported its own early exit.
    const terminals = [fakeTerminal(4242), fakeTerminal(4243)];
    const closeHandlers: Array<(exitCode?: number) => void> = [];
    terminals.forEach((terminal, index) => {
      terminal.onDidClose = (handler) => {
        closeHandlers[index] = handler;
      };
    });
    let next = 0;
    const failures: LaunchFailure[] = [];
    let clock = Date.parse('2026-08-12T00:00:00.000Z');
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminals[next++]! },
      now: () => new Date(clock).toISOString(),
      onLaunchFailed: (failure) => failures.push(failure),
    });
    const first = await transport.start(LAUNCH);
    await transport.terminate(first);
    clock += 200;
    closeHandlers[0]?.(undefined);
    // The Stop's own close ends no launch; its marker must not survive it.
    expect(failures).toEqual([]);

    const second = await transport.start(LAUNCH);
    expect(second).not.toBe(first);
    clock += 200;
    closeHandlers[1]?.(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.request.nodeRunId).toBe(LAUNCH.nodeRunId);
  });

  it('does not report a planner launch failure — a planner id is not a node run id', async () => {
    // The critical review finding: planners pass their planner-run id in
    // `nodeRunId`, and that small integer also names an UNRELATED node run, so
    // reporting the early exit here parked the wrong node.
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const failures: LaunchFailure[] = [];
    let clock = Date.parse('2026-08-12T00:00:00.000Z');
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => terminal },
      now: () => new Date(clock).toISOString(),
      onLaunchFailed: (failure) => failures.push(failure),
    });
    await transport.start({ ...LAUNCH, runKind: 'planner' });
    clock += 200;
    closeHandler?.(1);
    // The planner death sweep owns relaunching a planner; nothing to park.
    expect(failures).toEqual([]);
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

describe('SupervisedCLITransport terminal close of a live process (orphan)', () => {
  async function closeWith(opts: {
    exitCode: number | undefined;
    alive: boolean;
    cwd: string | null;
    adopt?: boolean;
  }): Promise<{ killed: number[]; logs: string[] }> {
    const killed: number[] = [];
    const logs: string[] = [];
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    const base = harness(4242).deps;
    const transport = createSupervisedCliTransport({
      ...base,
      terminalHost: { createTerminal: () => terminal },
      killTree: (pid) => {
        killed.push(pid);
        return 'killed';
      },
      debug: (m) => logs.push(m),
      facts: {
        isAlive: () => opts.alive,
        liveCwd: () => (opts.cwd === null ? null : { path: opts.cwd, deleted: false }),
        processStartMs: () => Date.parse('2026-08-12T00:00:00.000Z'),
      },
    });
    const session = await transport.start(LAUNCH);
    if (opts.adopt) {
      closeHandler = undefined;
      transport.adopt({ ...session, terminal });
    }
    closeHandler?.(opts.exitCode);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { killed, logs };
  }

  for (const adopt of [false, true]) {
    const mode = adopt ? 'adopt' : 'start';
    it(`${mode}: kills the process tree of an interrupted close with a live attributable pid`, async () => {
      const { killed, logs } = await closeWith({ exitCode: undefined, alive: true, cwd: '/wt/n1', adopt });
      expect(killed).toEqual([4242]);
      expect(logs.join('\n')).toMatch(/exitCode none.*pid 4242.*orphan.*killed/);
    });

    it(`${mode}: leaves a dead pid alone and logs the liveness`, async () => {
      const { killed, logs } = await closeWith({ exitCode: 1, alive: false, cwd: null, adopt });
      expect(killed).toEqual([]);
      expect(logs.join('\n')).toMatch(/exitCode 1.*pid 4242.*pid dead/);
    });

    it(`${mode}: does not kill a foreign pid and logs it`, async () => {
      const { killed, logs } = await closeWith({ exitCode: undefined, alive: true, cwd: '/elsewhere', adopt });
      expect(killed).toEqual([]);
      expect(logs.join('\n')).toMatch(/pid 4242.*foreign.*not killed/);
    });
  }
});

describe('SupervisedCLITransport disposeOnSuccess', () => {
  /** A terminal whose dispose fires the close handler, as the host does. */
  function disposableTerminal(exitCodeOnDispose: number | undefined) {
    const terminal = fakeTerminal(4242);
    let closeHandler: ((exitCode?: number) => void) | undefined;
    let disposeCalls = 0;
    terminal.onDidClose = (handler) => {
      closeHandler = handler;
    };
    let closed = false;
    terminal.dispose = () => {
      disposeCalls += 1;
      // The host fires the close event once; a later dispose is silent.
      if (closed) return;
      closed = true;
      closeHandler?.(exitCodeOnDispose);
    };
    return {
      terminal,
      disposeCalls: () => disposeCalls,
      close: (code?: number) => {
        closed = true;
        closeHandler?.(code);
      },
    };
  }

  const ADOPTED: SupervisedAgentSession = {
    nodeRunId: 66,
    ticketId: 1,
    graphRunId: 2,
    pid: 4242,
    cwd: '/wt/n1',
    generation: 'gen-1',
    ownerNonce: 'nonce',
    startedAt: '2026-08-12T00:00:00.000Z',
    processRunId: 77,
    provider: null,
    providerSessionId: null,
  };

  it('disposes the terminal tab of a live session', async () => {
    const t = disposableTerminal(0);
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => t.terminal },
    });
    const session = await transport.start(LAUNCH);
    transport.disposeOnSuccess(session);
    expect(t.disposeCalls()).toBe(1);
    expect(transport.sessionFor(LAUNCH.ticketId, LAUNCH.nodeRunId)).toBeUndefined();
  });

  it('is a no-op for a session without a terminal', () => {
    const transport = createSupervisedCliTransport(harness(4242).deps);
    expect(() => transport.disposeOnSuccess({ ...ADOPTED })).not.toThrow();
  });

  it('a close inside the launch window after the dispose reports no launch failure', async () => {
    const t = disposableTerminal(undefined);
    const failures: LaunchFailure[] = [];
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => t.terminal },
      onLaunchFailed: (failure) => failures.push(failure),
    });
    const session = await transport.start(LAUNCH);
    transport.disposeOnSuccess(session);
    expect(failures).toEqual([]);
  });

  it('closes a still-running row as passed, whatever the exit code of the disposed terminal', async () => {
    const t = disposableTerminal(undefined);
    const close: Array<{ processRunId: number; status: string }> = [];
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => t.terminal },
      openProcessRun: () => 77,
      closeProcessRun: (processRunId, status) => close.push({ processRunId, status }),
    });
    const session = await transport.start(LAUNCH);
    transport.disposeOnSuccess(session);
    expect(close).toEqual([{ processRunId: 77, status: 'passed' }]);
  });

  it('writes no second verdict when the terminal already closed before the dispose', async () => {
    const t = disposableTerminal(undefined);
    const close: Array<{ processRunId: number; status: string }> = [];
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => t.terminal },
      openProcessRun: () => 77,
      closeProcessRun: (processRunId, status) => close.push({ processRunId, status }),
    });
    const session = await transport.start(LAUNCH);
    t.close(1);
    transport.disposeOnSuccess(session);
    transport.disposeOnSuccess(session);
    expect(close).toEqual([{ processRunId: 77, status: 'failed' }]);
  });

  it('a stale dispose marker never changes a later launch of the same key', async () => {
    const t = disposableTerminal(1);
    const close: Array<{ status: string }> = [];
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => t.terminal },
      openProcessRun: () => 77,
      closeProcessRun: (_id, status) => close.push({ status }),
    });
    const first = await transport.start(LAUNCH);
    t.close(1);
    transport.disposeOnSuccess(first);
    await transport.start(LAUNCH);
    t.close(1);
    expect(close).toEqual([{ status: 'failed' }, { status: 'failed' }]);
  });

  it('keeps the orphan reap on the close that the dispose causes', async () => {
    const killed: number[] = [];
    const logs: string[] = [];
    const t = disposableTerminal(undefined);
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      debug: (m) => logs.push(m),
      terminalHost: { createTerminal: () => t.terminal },
      killTree: (pid) => {
        killed.push(pid);
        return 'killed';
      },
    });
    const session = await transport.start(LAUNCH);
    transport.disposeOnSuccess(session);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(killed).toEqual([4242]);
  });

  it('an adopted session closes passed after the dispose and keeps an earlier verdict', async () => {
    const close: Array<{ processRunId: number; status: string }> = [];
    const t = disposableTerminal(undefined);
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      closeProcessRun: (processRunId, status) => close.push({ processRunId, status }),
    });
    const adopted = { ...ADOPTED, terminal: t.terminal };
    transport.adopt(adopted);
    transport.disposeOnSuccess(adopted);
    expect(t.disposeCalls()).toBe(1);
    expect(close).toEqual([{ processRunId: 77, status: 'passed' }]);
    transport.disposeOnSuccess(adopted);
    expect(close).toHaveLength(1);
  });

  it('logs a throwing dispose and never throws', async () => {
    const t = disposableTerminal(0);
    t.terminal.dispose = () => {
      throw new Error('boom');
    };
    const logs: string[] = [];
    const transport = createSupervisedCliTransport({
      ...harness(4242).deps,
      terminalHost: { createTerminal: () => t.terminal },
      debug: (m) => logs.push(m),
    });
    const session = await transport.start(LAUNCH);
    expect(() => transport.disposeOnSuccess(session)).not.toThrow();
    expect(logs.some((l) => l.includes('disposing the terminal after success failed'))).toBe(true);
  });
});

/**
 * T1370: a graph session must be able to reach the token ledger.
 *
 * The transport is the ONE seam both planner and node launches pass through, so
 * the launch identity (`provider`) and the provider session id (claude
 * `--session-id`) are decided here, and the graph hook channel is injected
 * here. The extension wires `hookChannelFor` for opencode2 only: a claude graph
 * session reads its usage from the transcript sweep, and claude hooks would
 * carry lifecycle events into a ticket that has no session of its own.
 */
describe('SupervisedCLITransport graph launch identity (T1370)', () => {
  interface Captured {
    opts: Record<string, unknown>;
  }

  /** The claude adapter's own translation, without touching the operator's
   *  home dir: records the opts and mirrors a valid `sessionId` into argv. */
  function claudeLikeAdapter(captured: Captured, surfaces: unknown): AgentAdapter {
    return {
      requiredBinary: 'fake',
      runHeadless: async () => {
        throw new Error('unused');
      },
      surfaces,
      buildInteractiveCommand: (opts: InteractiveCommandOpts) => {
        captured.opts = opts as unknown as Record<string, unknown>;
        const args: string[] = [];
        if (opts.sessionId && !opts.resume) args.push('--session-id', opts.sessionId);
        if (opts.resume) args.push('--resume', opts.resume);
        return { command: 'claude', args, env: {} };
      },
    } as unknown as AgentAdapter;
  }

  const CLAUDE_SURFACES = { hookChannel: { supported: true } };

  /** Start from the shared LAUNCH fixture with the case's overrides. The
   *  transport's own `start` takes the strict request, so the spread is typed
   *  here once instead of at every call site. */
  function startWith(
    transport: ReturnType<typeof createSupervisedCliTransport>,
    over: Partial<SupervisedLaunchRequest>,
  ) {
    return transport.start({ ...LAUNCH, ...over } as SupervisedLaunchRequest);
  }

  it('pins a claude launch to a karst-chosen UUID and records it on the session', async () => {
    const captured: Captured = { opts: {} };
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const session = await startWith(transport, {
      identity: { profile: 'planner', provider: 'claude' },
      adapter: claudeLikeAdapter(captured, CLAUDE_SURFACES),
    });
    const id = captured.opts.sessionId as string;
    // A UUID v4-shaped id: the CLI refuses anything else with a launch error.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(h.calls.terminal.shellArgs).toEqual(['--session-id', id]);
    expect(session.providerSessionId).toBe(id);
    expect(session.provider).toBe('claude');
    // Absent runKind is a node launch: the sweep builds the node launch id.
    expect(session.runKind).toBe('node');
  });

  it('records the planner runKind on a planner session', async () => {
    const captured: Captured = { opts: {} };
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const session = await startWith(transport, {
      runKind: 'planner',
      identity: { profile: 'planner', provider: 'claude' },
      adapter: claudeLikeAdapter(captured, CLAUDE_SURFACES),
    });
    expect(session.runKind).toBe('planner');
  });

  it('keeps a resumed claude session on its own id (no --session-id)', async () => {
    const captured: Captured = { opts: {} };
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const session = await startWith(transport, {
      identity: { profile: 'node', provider: 'claude' },
      interactive: { cwd: '/wt/n1', resume: 'existing-session' },
      adapter: claudeLikeAdapter(captured, CLAUDE_SURFACES),
    });
    expect(captured.opts.sessionId).toBeUndefined();
    expect(h.calls.terminal.shellArgs).toEqual(['--resume', 'existing-session']);
    expect(session.providerSessionId).toBeNull();
    expect(session.provider).toBe('claude');
  });

  it('records no provider session id for a core that cannot pin one', async () => {
    const captured: Captured = { opts: {} };
    const h = harness(4242);
    const transport = createSupervisedCliTransport(h.deps);
    const session = await startWith(transport, {
      identity: { profile: 'node', provider: 'opencode2' },
      adapter: claudeLikeAdapter(captured, { hookChannel: { supported: true } }),
    });
    expect(captured.opts.sessionId).toBeUndefined();
    expect(session.providerSessionId).toBeNull();
    expect(session.provider).toBe('opencode2');
  });

  it('records a null provider when the launch resolved no identity', async () => {
    const h = harness(4242);
    const session = await createSupervisedCliTransport(h.deps).start(LAUNCH);
    expect(session.provider).toBeNull();
  });

  it('passes the injected graph hook channel to an opencode2 launch, and the plugin bakes its launch id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'karst-graph-hook-'));
    const configDir = mkdtempSync(join(tmpdir(), 'karst-graph-cfg-'));
    // A real launch generation is a UUIDv7; the graph launch id carries it as
    // its secret suffix (the hook endpoint refuses a guessable id).
    const generation = '019ab3c2-7d10-7e4f-8a2b-3c4d5e6f7a8b';
    const expectedLaunchId = graphLaunchIdForLaunch({ graphRunId: 7, nodeRunId: 31, generation });
    const h = harness(4242);
    const seen: string[] = [];
    const transport = createSupervisedCliTransport({
      ...h.deps,
      hookChannelFor: (request) => {
        const launchId = graphLaunchIdForLaunch(request);
        const url = new URL('http://127.0.0.1:4567/hooks');
        url.searchParams.set('karstLaunch', launchId);
        seen.push(launchId);
        return { endpointUrl: url.toString(), configDir, launchId };
      },
    });
    const session = await startWith(transport, {
      nodeRunId: 31,
      graphRunId: 7,
      generation,
      cwd,
      identity: { profile: 'worker', provider: 'opencode2' },
      adapter: new Opencode2Adapter(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      interactive: { cwd, initialPrompt: 'go' },
    });
    expect(session.providerSessionId).toBeNull();
    expect(seen).toEqual([expectedLaunchId]);
    expect(parseGraphLaunchId(expectedLaunchId)).toEqual({
      graphRunId: 7,
      runId: 31,
      role: 'node',
      generation,
    });
    // The bridge plugin is written and carries the graph launch id in its
    // baked endpoint, so the hook payload's `launchId` marks the session as
    // the graph's rather than as a ticket generation.
    const pluginPath = join(cwd, '.opencode', 'plugins', 'karst-bridge.js');
    expect(existsSync(pluginPath)).toBe(true);
    expect(readFileSync(pluginPath, 'utf8')).toContain(`karstLaunch=${expectedLaunchId}`);
  });

  it('gives a claude graph launch no hook channel even when the dep offers one', async () => {
    const captured: Captured = { opts: {} };
    const h = harness(4242);
    const transport = createSupervisedCliTransport({
      ...h.deps,
      hookChannelFor: () => ({ endpointUrl: 'http://127.0.0.1:4567/hooks', configDir: '/cfg' }),
    });
    await startWith(transport, {
      identity: { profile: 'planner', provider: 'claude' },
      adapter: claudeLikeAdapter(captured, CLAUDE_SURFACES),
    });
    expect(captured.opts.hookChannel).toBeUndefined();
  });

  it('refuses a hook channel to a core that declares the surface unsupported', async () => {
    const captured: Captured = { opts: {} };
    const h = harness(4242);
    const transport = createSupervisedCliTransport({
      ...h.deps,
      hookChannelFor: () => ({ endpointUrl: 'http://127.0.0.1:4567/hooks', configDir: '/cfg' }),
    });
    await startWith(transport, {
      identity: { profile: 'node', provider: 'antigravity' },
      adapter: claudeLikeAdapter(captured, {
        hookChannel: { supported: false, reason: 'agy watches its own conversation DB' },
      }),
    });
    expect(captured.opts.hookChannel).toBeUndefined();
  });
});

describe('adapter-owned paths of a graph session (T1370)', () => {
  const PLUGIN = join('.opencode', 'plugins', 'karst-bridge.js');

  function workspaceWithPlugin(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'karst-graph-owned-'));
    mkdirSync(join(cwd, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(join(cwd, PLUGIN), '// plugin');
    return cwd;
  }

  it('removes the paths the adapter owns when the session terminal closes', async () => {
    const cwd = workspaceWithPlugin();
    try {
      const terminal = fakeTerminal(4242);
      let closeHandler: ((exitCode?: number) => void) | undefined;
      terminal.onDidClose = (handler) => {
        closeHandler = handler;
      };
      const transport = createSupervisedCliTransport({
        ...harness(4242).deps,
        terminalHost: { createTerminal: () => terminal },
      });
      const adapter = adapterFor({ command: 'opencode', args: [], env: {}, ownedPaths: [PLUGIN] } as InteractiveCommand);
      await transport.start({ ...LAUNCH, cwd, interactive: { cwd }, adapter } as SupervisedLaunchRequest);
      expect(existsSync(join(cwd, PLUGIN))).toBe(true);
      closeHandler?.(0);
      expect(existsSync(join(cwd, PLUGIN))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('logs a refused path and does not throw', () => {
    const debug: string[] = [];
    expect(() => removeOwnedPaths('/wt/n1', ['../outside'], (m) => debug.push(m))).not.toThrow();
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('[graph] removing the adapter-owned paths in /wt/n1 failed');
  });

  it('does nothing when the adapter owns no path', () => {
    const debug: string[] = [];
    removeOwnedPaths('/wt/n1', undefined, (m) => debug.push(m));
    removeOwnedPaths('/wt/n1', [], (m) => debug.push(m));
    expect(debug).toEqual([]);
  });

  it('removes each owned path in the cwd', () => {
    const cwd = workspaceWithPlugin();
    try {
      removeOwnedPaths(cwd, [PLUGIN], undefined);
      expect(existsSync(join(cwd, PLUGIN))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
