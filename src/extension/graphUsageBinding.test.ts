import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload } from '../hooks/dispatch.js';
import { encodeClaudeProjectDir } from '../agent/claudeTranscriptWatch.js';
import type { SupervisedAgentSession } from '../approaches/graph/transport/agentTransport.js';
import type { SupervisedLaunchRequest } from '../approaches/graph/transport/supervisedCliTransport.js';
import { createGraphUsageBinding, graphClaudeSessionOf, type GraphUsageBindingDeps } from './graphUsageBinding.js';

const GEN = '11111111-2222-4333-8444-555555555555';

function harness(over: Partial<GraphUsageBindingDeps> = {}): { deps: GraphUsageBindingDeps; debug: string[] } {
  const debug: string[] = [];
  const deps: GraphUsageBindingDeps = {
    endpointUrl: () => 'http://127.0.0.1:4000/hook?x=1',
    configDir: '/cfg',
    projectKey: () => 'proj',
    sessions: () => [],
    dispatch: () => undefined,
    projectsDirFor: () => '/projects',
    debug: (m) => { debug.push(m); },
    onError: () => undefined,
    ...over,
  };
  return { deps, debug };
}

function request(provider: string | undefined, runKind?: 'node' | 'planner'): SupervisedLaunchRequest {
  return {
    nodeRunId: 7,
    ticketId: 1,
    graphRunId: 3,
    generation: GEN,
    ...(runKind ? { runKind } : {}),
    ...(provider ? { identity: { profile: 'worker', provider, model: 'm' } } : {}),
  } as unknown as SupervisedLaunchRequest;
}

describe('createGraphUsageBinding.hookChannelFor', () => {
  it('gives an opencode2 launch a channel that carries the graph launch id', () => {
    const binding = createGraphUsageBinding(harness().deps);
    const channel = binding.hookChannelFor(request('opencode2', 'planner'));
    expect(channel).toEqual({
      endpointUrl: `http://127.0.0.1:4000/hook?x=1&karstLaunch=graph-3-planner-7-${GEN}`,
      configDir: '/cfg',
      launchId: `graph-3-planner-7-${GEN}`,
      projectKey: 'proj',
    });
  });

  it('gives an opencode launch a channel too (T1380)', () => {
    const channel = createGraphUsageBinding(harness().deps).hookChannelFor(request('opencode', 'node'));
    expect(channel?.launchId).toBe(`graph-3-node-7-${GEN}`);
  });

  it('gives a claude launch no channel (its usage comes from the transcript sweep)', () => {
    expect(createGraphUsageBinding(harness().deps).hookChannelFor(request('claude'))).toBeUndefined();
  });

  it('gives a launch with no identity no channel', () => {
    expect(createGraphUsageBinding(harness().deps).hookChannelFor(request(undefined))).toBeUndefined();
  });

  it('gives no channel and logs a debug line while the endpoint is not bound', () => {
    const h = harness({ endpointUrl: () => undefined });
    expect(createGraphUsageBinding(h.deps).hookChannelFor(request('opencode2'))).toBeUndefined();
    expect(h.debug).toEqual(['[graph] hook endpoint is not bound — the launch records no usage']);
  });
});

describe('graphClaudeSessionOf', () => {
  const session = {
    nodeRunId: 9,
    ticketId: 1,
    graphRunId: 3,
    cwd: '/ws/n9',
    generation: GEN,
    provider: 'claude',
    providerSessionId: 'sid',
  } as unknown as SupervisedAgentSession;

  it('maps a transport session to a host graph session (absent runKind = node)', () => {
    expect(graphClaudeSessionOf(session)).toEqual({
      ticketId: 1,
      graphRunId: 3,
      runId: 9,
      role: 'node',
      cwd: '/ws/n9',
      provider: 'claude',
      providerSessionId: 'sid',
      generation: GEN,
      placement: 'host',
    });
  });

  it('keeps the planner role', () => {
    expect(graphClaudeSessionOf({ ...session, runKind: 'planner' }).role).toBe('planner');
  });
});

describe('createGraphUsageBinding.sweep', () => {
  it('sweeps no session when the transport reports none', async () => {
    expect(await createGraphUsageBinding(harness().deps).sweep()).toBe(0);
  });

  it('skips a session whose provider is not claude', async () => {
    const h = harness({
      sessions: () => [{ nodeRunId: 1, ticketId: 1, graphRunId: 3, cwd: '/c', generation: GEN, provider: 'opencode2', providerSessionId: null } as unknown as SupervisedAgentSession],
    });
    expect(await createGraphUsageBinding(h.deps).sweep()).toBe(0);
  });

  describe('with a claude transcript on disk', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'karst-graph-usage-binding-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reads the transcript of a live claude session and posts one UsageUpdate', async () => {
      const cwd = '/repo/.karst/worktrees/x';
      const sessionId = '3f2b6c1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c';
      const projectDir = join(dir, encodeClaudeProjectDir(cwd));
      mkdirSync(projectDir, { recursive: true });
      const line = JSON.stringify({ type: 'assistant', uuid: 'm-1', message: { usage: { input_tokens: 10, output_tokens: 5 } } });
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${line}\n`);
      const posted: HookPayload[] = [];
      const askedFor: string[] = [];
      const h = harness({
        sessions: () => [{ nodeRunId: 121, ticketId: 1368, graphRunId: 81, runKind: 'planner', cwd, generation: GEN, provider: 'claude', providerSessionId: sessionId } as unknown as SupervisedAgentSession],
        dispatch: (p) => { posted.push(p); },
        projectsDirFor: (id) => { askedFor.push(id); return dir; },
      });
      expect(await createGraphUsageBinding(h.deps).sweep()).toBe(1);
      expect(askedFor).toEqual([sessionId]);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ hook_event_name: 'UsageUpdate', cwd, session_id: sessionId });
    });
  });
});

describe('createGraphUsageBinding.sweep — claude usage-limit signal (T1380)', () => {
  const cwd = '/repo/.karst/worktrees/x';
  const sessionId = '3f2b6c1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c';
  const QUOTA = "You've hit your 5-hour limit · resets 4:10am";

  function errorLine(text = QUOTA, uuid = 'err-1'): string {
    return JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      uuid,
      message: { content: [{ type: 'text', text }] },
    });
  }

  function append(line: string): void {
    const projectDir = join(dir, encodeClaudeProjectDir(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${line}\n`, { flag: 'a' });
  }

  function write(line: string): void {
    const projectDir = join(dir, encodeClaudeProjectDir(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${line}\n`);
  }

  function session(): SupervisedAgentSession {
    return {
      nodeRunId: 121,
      ticketId: 1368,
      graphRunId: 81,
      runKind: 'planner',
      cwd,
      generation: GEN,
      provider: 'claude',
      providerSessionId: sessionId,
    } as unknown as SupervisedAgentSession;
  }

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-graph-usage-limit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a trailing claude quota error once, with the graph session identity', async () => {
    write(errorLine());
    const signals: unknown[] = [];
    const h = harness({
      sessions: () => [session()],
      projectsDirFor: () => dir,
      onGraphUsageLimit: (signal) => { signals.push(signal); },
    });
    const binding = createGraphUsageBinding(h.deps);
    expect(await binding.sweep()).toBe(1);
    expect(signals).toEqual([
      { ticketId: 1368, graphRunId: 81, runId: 121, role: 'planner', provider: 'claude', text: QUOTA },
    ]);
  });

  it('reports the same error line once even when a later sweep changes the fingerprint', async () => {
    write(errorLine());
    const signals: unknown[] = [];
    const h = harness({
      sessions: () => [session()],
      projectsDirFor: () => dir,
      onGraphUsageLimit: (signal) => { signals.push(signal); },
    });
    const binding = createGraphUsageBinding(h.deps);
    await binding.sweep();
    append(JSON.stringify({ type: 'system', subtype: 'turn_duration' }));
    await binding.sweep();
    expect(signals).toHaveLength(1);
  });

  it('reports nothing when a human prompt follows the error', async () => {
    write(`${errorLine()}\n${JSON.stringify({ type: 'user', origin: { kind: 'human' } })}`);
    const signals: unknown[] = [];
    const h = harness({
      sessions: () => [session()],
      projectsDirFor: () => dir,
      onGraphUsageLimit: (signal) => { signals.push(signal); },
    });
    await createGraphUsageBinding(h.deps).sweep();
    expect(signals).toEqual([]);
  });

  it('reports nothing for a non-quota API error', async () => {
    write(errorLine('API Error: 500 internal server error'));
    const signals: unknown[] = [];
    const h = harness({
      sessions: () => [session()],
      projectsDirFor: () => dir,
      onGraphUsageLimit: (signal) => { signals.push(signal); },
    });
    await createGraphUsageBinding(h.deps).sweep();
    expect(signals).toEqual([]);
  });
});
