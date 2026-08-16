/**
 * AcpTransport (Slice 6 Task 1).
 *
 * ACP implements the SAME `AgentTransport` boundary as `SupervisedCLITransport`
 * and is selected only when the core supports it (`acpSupportedFor` — empty in
 * V1, so every core keeps `SupervisedCLITransport`). It mirrors the CLI
 * transport's lifecycle exactly: the caller-persisted owner nonce carried onto
 * the session, process/start identity recorded immediately after, process_runs
 * accounting, servers-registry registration keyed by cwd, and termination
 * only through the attributed facts + serverIdentity path.
 *
 * The DIFFERENCE is the launch vehicle and the boundary rules:
 * - instead of spawning a CLI it drives an injected `acp` client (launch,
 *   subscribe to events, request permission, cancel);
 * - an ACP `session-ended` / `cancelled` / `error` event maps to termination
 *   evidence ONLY (the process_runs accounting row closes as `interrupted`) —
 *   never to an outcome; the guarded completion protocol (`karst node …`) is
 *   the only outcome path;
 * - a peer-delegation message is REFUSED, never forwarded;
 * - the endpoint must be loopback-bound with no remote callback addresses.
 */

import { describe, it, expect } from 'vitest';
import {
  createAcpTransport,
  refusePeerDelegation,
  assertLoopbackEndpoint,
  AcpEndpointError,
  acpSupportedFor,
  type AcpTransportDeps,
  type AcpLaunchRequest,
  type AcpClient,
  type AcpSessionHandle,
  type AcpEvent,
} from './acpTransport.js';
import type { KillOutcome } from '../../../runtime/processTree.js';

interface FakeHandle extends AcpSessionHandle {
  listeners: Array<(event: AcpEvent) => void>;
  cancelled: boolean;
  permissionReplies: Array<{ requestId: string; allow: boolean }>;
}

function fakeHandle(pid?: number): FakeHandle {
  const handle: FakeHandle = {
    sessionId: 'acp-session-1',
    pid: pid ?? null,
    listeners: [],
    cancelled: false,
    permissionReplies: [],
    onEvent: (listener) => {
      handle.listeners.push(listener);
    },
    requestPermission: async (requestId, allow) => {
      handle.permissionReplies.push({ requestId, allow });
    },
    cancel: async () => {
      handle.cancelled = true;
    },
  };
  return handle;
}

interface Harness {
  deps: AcpTransportDeps;
  calls: {
    order: string[];
    nonce: string;
    started: { sessionName: string; cwd: string; env: Record<string, string>; initialPrompt: string };
  };
  sessions: { ticketId: number; repo: string; pid: number | null; cwd: string; startedAt: string }[];
  messages: Array<{ nodeRunId: number; content: string }>;
  handle: FakeHandle;
  emit: (event: AcpEvent) => void;
}

function harness(pid?: number): Harness {
  const fake = fakeHandle(pid);
  const calls: Harness['calls'] = {
    order: [],
    nonce: '',
    started: { sessionName: '', cwd: '', env: {}, initialPrompt: '' },
  };
  const sessions: Harness['sessions'] = [];
  const messages: Harness['messages'] = [];
  const acp: AcpClient = {
    startSession: async (input) => {
      calls.order.push('start');
      calls.started = input;
      return fake;
    },
  };
  const deps: AcpTransportDeps = {
    endpoint: 'http://127.0.0.1:4103',
    acp,
    recordSession: (row) => {
      calls.order.push('record');
      sessions.push(row);
    },
    onMessage: (nodeRunId, message) => {
      messages.push({ nodeRunId, content: message.content });
    },
    killTree: () => 'killed' as KillOutcome,
    facts: {
      isAlive: () => true,
      liveCwd: () => ({ path: '/wt/n1', deleted: false }),
      processStartMs: () => 1_700_000_000_000,
    },
    now: () => '2026-08-12T00:00:00.000Z',
  };
  return {
    deps,
    calls,
    sessions,
    messages,
    handle: fake,
    emit: (event) => {
      for (const listener of fake.listeners) listener(event);
    },
  };
}

const LAUNCH: AcpLaunchRequest = {
  nodeRunId: 11,
  ticketId: 1,
  graphRunId: 2,
  repo: 'api',
  cwd: '/wt/n1',
  generation: 'gen-1',
  ownerNonce: 'a'.repeat(32),
  sessionName: 'Karst node 11',
  graphEnv: { KARST_GRAPH_RUN_ID: '2', KARST_GRAPH_CALLBACK_URL: 'http://127.0.0.1:9/wakeup' },
  initialPrompt: 'the node prompt',
};

describe('AcpTransport lifecycle mirrors SupervisedCLITransport', () => {
  it('carries the caller-persisted owner nonce and records identity immediately after the session starts', async () => {
    const h = harness(4242);
    const transport = createAcpTransport(h.deps);
    const session = await transport.start(LAUNCH);
    expect(h.calls.order).toEqual(['start', 'record']);
    expect(h.calls.started).toMatchObject({
      sessionName: 'Karst node 11',
      cwd: '/wt/n1',
      initialPrompt: 'the node prompt',
    });
    expect(h.calls.started.env).toMatchObject({ KARST_GRAPH_RUN_ID: '2' });
    expect(session).toMatchObject({
      nodeRunId: 11,
      ticketId: 1,
      graphRunId: 2,
      pid: 4242,
      cwd: '/wt/n1',
      generation: 'gen-1',
      startedAt: '2026-08-12T00:00:00.000Z',
      providerSessionId: 'acp-session-1',
    });
    // The nonce is the CLAIM transaction's — the transport never mints one.
    expect(session.ownerNonce).toBe(LAUNCH.ownerNonce);
    expect(session.terminal).toBeUndefined(); // ACP has no terminal surface
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ ticketId: 1, repo: 'api', pid: 4242, cwd: '/wt/n1' });
  });

  it('records a null pid when the client reports none', async () => {
    const h = harness();
    const transport = createAcpTransport(h.deps);
    const session = await transport.start(LAUNCH);
    expect(session.pid).toBeNull();
    expect(session.startedAt).toBeNull();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ pid: null, cwd: '/wt/n1' });
  });

  it('keeps sessions in its own (ticketId, nodeRunId) registry', async () => {
    const h = harness(4242);
    const transport = createAcpTransport(h.deps);
    await transport.start(LAUNCH);
    expect(transport.sessions()).toHaveLength(1);
    expect(transport.sessionFor(1, 11)?.pid).toBe(4242);
    expect(transport.sessionFor(1, 99)).toBeUndefined();
  });

  it('a graph launch opens exactly one process_runs row and is counted once', async () => {
    const h = harness(4242);
    const opened: number[] = [];
    const transport = createAcpTransport({
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
    expect(h.calls.order).toEqual(['start', 'open', 'record']);
  });

  it('a locked database never fails the launch', async () => {
    const h = harness(4242);
    const transport = createAcpTransport({
      ...h.deps,
      openProcessRun: () => {
        throw new Error('database is locked');
      },
    });
    const session = await transport.start(LAUNCH);
    expect(session.pid).toBe(4242);
    expect(session.processRunId).toBeNull();
  });
});

describe('AcpTransport termination mirrors SupervisedCLITransport', () => {
  it('requests a protocol cancel, then terminates an attributable pid via the process group', async () => {
    const h = harness(4242);
    let signalled: number | undefined;
    const transport = createAcpTransport({
      ...h.deps,
      killTree: (pid) => {
        signalled = pid;
        return 'killed';
      },
    });
    const session = await transport.start(LAUNCH);
    const proof = await transport.terminate(session);
    expect(h.handle.cancelled).toBe(true);
    expect(signalled).toBe(4242);
    expect(proof).toEqual({ kind: 'attributable', kill: 'killed' });
  });

  it('a denied kill reads as NOT terminated — the row stays running and the lease stays held', async () => {
    const h = harness(4242);
    const transport = createAcpTransport({ ...h.deps, killTree: () => 'denied' });
    const session = await transport.start(LAUNCH);
    const proof = await transport.terminate(session);
    expect(proof).toEqual({ kind: 'attributable', kill: 'denied' });
  });

  it('a reissued pid reads foreign and signals nothing', async () => {
    const h = harness(4242);
    let signalled = false;
    const transport = createAcpTransport({
      ...h.deps,
      facts: {
        isAlive: () => true,
        liveCwd: () => ({ path: '/somewhere/else', deleted: false }),
        processStartMs: () => 1_700_000_000_999, // outside START_TIME_TOLERANCE_MS
      },
      killTree: () => {
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
    const deadTransport = createAcpTransport({
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

    const unknownTransport = createAcpTransport({
      ...h.deps,
      facts: { isAlive: () => true, liveCwd: () => null, processStartMs: () => null },
    });
    const unknownSession = await unknownTransport.start(LAUNCH);
    expect(await unknownTransport.terminate(unknownSession)).toEqual({ kind: 'unknown' });
    expect(signalled).toBe(false);

    const noPid = createAcpTransport(h.deps);
    const noPidSession = await noPid.start({ ...LAUNCH, nodeRunId: 12 });
    expect(noPidSession.pid).not.toBeNull();
  });

  it('a session that never reported a pid terminates unknown', async () => {
    const h = harness();
    const transport = createAcpTransport(h.deps);
    const session = await transport.start(LAUNCH);
    expect(await transport.terminate(session)).toEqual({ kind: 'unknown' });
  });
});

describe('AcpTransport outcome/termination boundary', () => {
  it('an ACP session end is termination evidence only — never an outcome', async () => {
    const h = harness(4242);
    const close: Array<{ processRunId: number; status: string }> = [];
    const transport = createAcpTransport({
      ...h.deps,
      openProcessRun: () => 77,
      closeProcessRun: (processRunId, status) => {
        close.push({ processRunId, status });
      },
    });
    const session = await transport.start(LAUNCH);
    expect(close).toEqual([]);
    h.emit({ type: 'session-ended', reason: 'completed' });
    // Termination evidence: the accounting row closes as `interrupted` — a
    // session end with no exit code, exactly like a killed/failed-to-start
    // terminal in the CLI transport. The NODE OUTCOME is never written by the
    // transport: it arrives only via the guarded completion protocol.
    expect(close).toEqual([{ processRunId: 77, status: 'interrupted' }]);
    expect(session.pid).toBe(4242);
    expect(transport.sessionFor(1, 11)).toBeUndefined();
    // A second end event closes nothing (the accounting row is already closed
    // — the store's guarded close is what ignores it; the transport fires once).
    h.emit({ type: 'session-ended', reason: 'cancelled' });
    expect(close).toHaveLength(1);
  });

  it('an ACP session error is also termination evidence only, never an outcome', async () => {
    const h = harness(4242);
    const close: Array<{ processRunId: number; status: string }> = [];
    const transport = createAcpTransport({
      ...h.deps,
      openProcessRun: () => 77,
      closeProcessRun: (processRunId, status) => {
        close.push({ processRunId, status });
      },
    });
    await transport.start(LAUNCH);
    h.emit({ type: 'session-ended', reason: 'error', message: 'connection reset' });
    expect(close).toEqual([{ processRunId: 77, status: 'interrupted' }]);
  });

  it('forgets a terminal ACP session and its handle after ending', async () => {
    // A terminal transport session has no further lifecycle work to supervise.
    // Keeping either map entry leaks the handle and lets stale session lookups
    // appear live after the ACP peer has ended it.
    const h = harness(4242);
    const transport = createAcpTransport(h.deps);
    await transport.start(LAUNCH);

    h.emit({ type: 'session-ended', reason: 'cancelled' });

    expect(transport.sessions()).toEqual([]);
    expect(transport.sessionFor(1, 11)).toBeUndefined();
    await transport.requestPermission(1, 11, 'late-request', true);
    expect(h.handle.permissionReplies).toEqual([]);
  });

  it('a peer-delegation message is refused and never forwarded', async () => {
    const h = harness(4242);
    const transport = createAcpTransport(h.deps);
    await transport.start(LAUNCH);
    h.emit({
      type: 'message',
      message: { role: 'assistant', content: 'run this on worker-b', targetNodeId: 'worker-b' },
    });
    expect(h.messages).toEqual([]);
    // A benign stream message IS forwarded.
    h.emit({ type: 'message', message: { role: 'assistant', content: 'reporting in' } });
    expect(h.messages).toEqual([{ nodeRunId: 11, content: 'reporting in' }]);
  });
});

describe('AcpTransport boundary refusals (pure)', () => {
  it('refusePeerDelegation refuses a message naming another node/agent to run', () => {
    expect(
      refusePeerDelegation({ role: 'assistant', content: 'do it', targetNodeId: 'worker-b' }),
    ).toBe(true);
    expect(refusePeerDelegation({ role: 'assistant', content: 'do it' })).toBe(false);
  });

  it('refusePeerDelegation refuses a tool that spawns peers', () => {
    expect(refusePeerDelegation({ role: 'assistant', content: 'x', toolName: 'delegate_agent' })).toBe(
      true,
    );
    expect(refusePeerDelegation({ role: 'assistant', content: 'x', toolName: 'run_node' })).toBe(true);
    expect(refusePeerDelegation({ role: 'assistant', content: 'x', toolName: 'write_file' })).toBe(false);
  });

  it('assertLoopbackEndpoint accepts loopback endpoints and refuses a non-loopback host', () => {
    expect(() => assertLoopbackEndpoint('http://127.0.0.1:4103')).not.toThrow();
    expect(() => assertLoopbackEndpoint('http://[::1]:4103')).not.toThrow();
    expect(() => assertLoopbackEndpoint('http://localhost:4103')).not.toThrow();
    expect(() => assertLoopbackEndpoint('http://192.168.1.50:4103')).toThrow(AcpEndpointError);
    expect(() => assertLoopbackEndpoint('http://example.com:4103')).toThrow(AcpEndpointError);
  });

  it('assertLoopbackEndpoint refuses a remote callback address', () => {
    expect(() =>
      assertLoopbackEndpoint('http://127.0.0.1:4103?callback=http://remote.example/cb'),
    ).toThrow(AcpEndpointError);
    expect(() => assertLoopbackEndpoint('http://127.0.0.1:4103?cb=http://127.0.0.1:9/cb')).not.toThrow();
    expect(() => assertLoopbackEndpoint('not a url')).toThrow(AcpEndpointError);
  });

  it('a non-loopback endpoint fails construction with a named error', () => {
    const h = harness(4242);
    expect(() =>
      createAcpTransport({ ...h.deps, endpoint: 'http://192.168.1.50:4103' }),
    ).toThrow(AcpEndpointError);
  });

  it('acpSupportedFor is empty in V1 — no known core is routed to ACP', () => {
    for (const core of ['claude', 'codex', 'agy', 'opencode', 'antigravity']) {
      expect(acpSupportedFor(core)).toBe(false);
    }
  });
});
