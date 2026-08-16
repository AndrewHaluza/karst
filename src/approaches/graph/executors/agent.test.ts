/**
 * Agent node executor tests (Slice 3 Task 4).
 *
 * Fresh-session context carries no transcript and no `--resume`; a
 * fallback-incapable core red-blocks before spend; provider/model/effort and
 * the prompt hash are frozen for the launch attempt.
 */

import { describe, it, expect } from 'vitest';
import {
  composeNodePrompt,
  runAgentNode,
  type RunAgentNodeDeps,
  type RunAgentNodeInput,
} from './agent.js';
import { SUPPORTED, unsupported } from '../../../agent/surfaces.js';
import type { AgentNode } from '../parse.js';
import type {
  AgentTransport,
  SupervisedAgentSession,
  SupervisedLaunchRequest,
} from '../transport/supervisedCliTransport.js';

function agentNode(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'worker-a',
    kind: 'agent',
    label: 'Worker A',
    profile: 'worker',
    instructionsArtifact: 'instr',
    inputs: ['task'],
    outputs: ['result'],
    resources: { reads: [], writes: [] },
    outcomes: ['complete', 'blocked', 'replan'],
    budget: { maxVisits: 3 },
    ...overrides,
  };
}

interface FakeTransport extends AgentTransport {
  starts: SupervisedLaunchRequest[];
  capability: boolean;
}

function fakeTransport(capability: boolean): FakeTransport {
  const starts: SupervisedLaunchRequest[] = [];
  return {
    starts,
    capability,
    capabilities: () => ({ exactModel: capability, attributedTermination: true }),
    start: async (launch: SupervisedLaunchRequest) => {
      starts.push(launch);
      return {
        nodeRunId: launch.nodeRunId,
        ticketId: launch.ticketId,
        graphRunId: launch.graphRunId,
        pid: 4242,
        cwd: launch.cwd,
        generation: launch.generation,
        ownerNonce: 'n',
        startedAt: '2026-08-12T00:00:00.000Z',
        processRunId: null,
        providerSessionId: null,
        terminal: {} as never,
      };
    },
    terminate: async () => ({ kind: 'attributable', kill: 'killed' }),
  };
}

function harness(transport: FakeTransport): {
  deps: RunAgentNodeDeps;
  input: RunAgentNodeInput;
  prompts: string[];
} {
  const prompts: string[] = [];
  const deps: RunAgentNodeDeps = {
    transport,
    resolveProfile: (profile) =>
      profile === 'expert' ? { provider: 'claude', model: 'opus', effort: 'high' } : { provider: 'codex', effort: 'low' },
    readInstructions: () => '# instructions',
    readInputs: () => ['# input task'],
    ticketContext: '# ticket',
    nodePrompt: '# karst-graph-node',
    promptHash: (text) => {
      prompts.push(text);
      return `hash:${text.length}`;
    },
    graphEnv: () => ({ KARST_GRAPH_RUN_ID: '2' }),
    sessionNamingOf: (_graphRunId, runId, kind) => ({ name: `Karst ${kind} ${runId}`, iconPath: '/icon/karst.svg' }),
  };
  const input: RunAgentNodeInput = {
    nodeRunId: 11,
    ticketId: 1,
    graphRunId: 2,
    revisionId: 3,
    adapter: {
      surfaces: {
        exactModel: SUPPORTED,
      },
    } as never,
    repo: 'api',
    cwd: '/wt/n1',
    node: agentNode(),
    generation: 'gen-1',
    ownerNonce: 'a'.repeat(32),
    instructionsSnapshot: '/snap/instr',
    inputSnapshots: ['/snap/task'],
  };
  return { deps, input, prompts };
}

describe('runAgentNode', () => {
  it('names the node session from the injected naming bag', async () => {
    const transport = fakeTransport(true);
    const h = harness(transport);
    const result = await runAgentNode(h.deps, h.input);
    expect(result.kind).toBe('launched');
    if (result.kind !== 'launched') return;
    const launch = transport.starts[0]!;
    expect(launch.sessionName).toBe('Karst node 11');
    expect(launch.sessionIconPath).toBe('/icon/karst.svg');
    expect(launch.interactive.sessionName).toBe('Karst node 11');
  });

  it('launches a fresh session: no --resume, no prior-node transcript', async () => {
    const transport = fakeTransport(true);
    const h = harness(transport);
    const result = await runAgentNode(h.deps, h.input);
    expect(result.kind).toBe('launched');
    if (result.kind !== 'launched') return;
    expect(transport.starts).toHaveLength(1);
    const launch = transport.starts[0]!;
    expect(launch.interactive.resume).toBeUndefined();
    // The seed is the node prompt + ticket context + instructions + declared
    // inputs — nothing else; no transcript exists to carry.
    expect(launch.interactive.initialPrompt).toBe(
      composeNodePrompt('# karst-graph-node', '# ticket', '# instructions', ['# input task']),
    );
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toBe(launch.interactive.initialPrompt);
    expect(result.identity).toMatchObject({
      provider: 'codex',
      effort: 'low',
      promptHash: `hash:${h.prompts[0]!.length}`,
    });
  });

  it('freezes provider/model/effort from the profile resolution', async () => {
    const transport = fakeTransport(true);
    const h = harness(transport);
    h.input.node = agentNode({ profile: 'expert' });
    const result = await runAgentNode(h.deps, h.input);
    expect(result.kind).toBe('launched');
    if (result.kind !== 'launched') return;
    expect(result.identity).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high' });
    const launch = transport.starts[0]!;
    expect(launch.interactive.model).toBe('opus');
    expect(launch.interactive.effort).toBe('high');
  });

  it('a fallback-incapable core red-blocks BEFORE any spend', async () => {
    const transport = fakeTransport(false);
    const h = harness(transport);
    h.input.adapter = {
      surfaces: {
        exactModel: unsupported(
          'this adapter cannot prevent model fallback or prove which model ran in the session',
        ),
      },
    } as never;
    const result = await runAgentNode(h.deps, h.input);
    expect(result).toMatchObject({ kind: 'red-blocked' });
    if (result.kind !== 'red-blocked') return;
    expect(result.reason).toContain('exact-model-capability');
    expect(transport.starts).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
  });

  it('launches when the adapter declares exact-model support even if the transport constant is false', async () => {
    const transport = fakeTransport(false);
    const h = harness(transport);
    h.input.adapter = {
      surfaces: {
        exactModel: SUPPORTED,
      },
    } as never;
    const result = await runAgentNode(h.deps, h.input);
    expect(result.kind).toBe('launched');
    expect(transport.starts).toHaveLength(1);
  });

  it('red-blocks when the adapter declares exact-model unsupported', async () => {
    const transport = fakeTransport(true);
    const h = harness(transport);
    h.input.adapter = {
      surfaces: {
        exactModel: unsupported(
          'this adapter cannot prevent model fallback or prove which model ran in the session',
        ),
      },
    } as never;
    const result = await runAgentNode(h.deps, h.input);
    expect(result).toMatchObject({ kind: 'red-blocked' });
    expect(transport.starts).toHaveLength(0);
  });
});
