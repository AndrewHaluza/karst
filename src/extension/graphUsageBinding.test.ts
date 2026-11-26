import { describe, expect, it } from 'vitest';
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
});
