/**
 * Pure compiler, canonicalizer, and fingerprint (Slice 2 Task 4).
 *
 * One rejection test per validation bullet; the reference graph's canonical
 * bytes and SHA-256 fingerprint are pinned and must not change across
 * dependency upgrades; the expert-budget formula rejects an over-budget
 * expert node; a join budgeted below its fork's multiplicity is rejected at
 * compile; the overlap warning fires as a diagnostic and does not fail
 * compilation.
 */

import { describe, it, expect } from 'vitest';
import { parseGraphDocument, type GraphDocument } from './parse.js';
import {
  compileGraphDocument,
  type CompileContext,
  type CompileDiagnostic,
  type CompileDiagnosticCode,
} from './compile.js';

/** The reference graph whose canonical bytes and fingerprint are pinned. */
const REF_JSON = JSON.stringify({
  version: 1,
  title: 'Reference graph',
  rationaleArtifact: 'task',
  entries: ['a'],
  artifacts: [
    {
      id: 'task',
      path: 'artifacts/plan/task.md',
      producer: '$planner',
      consumers: ['a'],
      mediaType: 'text/markdown',
      maxBytes: 1024,
      required: true,
    },
    {
      id: 'result',
      path: 'artifacts/results/result.md',
      producer: 'a',
      consumers: [],
      mediaType: 'text/markdown',
      maxBytes: 1024,
      required: true,
    },
  ],
  nodes: [
    {
      id: 'a',
      kind: 'agent',
      label: 'Do the work',
      profile: 'worker',
      instructionsArtifact: 'task',
      inputs: ['task'],
      outputs: ['result'],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked', 'replan'],
      budget: { maxVisits: 1 },
    },
    {
      id: 'v',
      kind: 'command',
      label: 'Verify',
      command: 'test',
      repositories: ['api'],
      outcomes: ['passed', 'failed', 'infrastructure-error'],
      budget: { maxVisits: 2 },
    },
  ],
  edges: [
    { id: 'a-done', from: 'a', on: 'complete', to: 'v' },
    { id: 'v-pass', from: 'v', on: 'passed', to: 'END' },
    { id: 'v-fail', from: 'v', on: 'failed', to: 'END' },
  ],
  budgets: { maxNodeRuns: 4, maxExpertRuns: 1, maxReplans: 0 },
});

/** A valid fork/join graph: entry agent fans out through a command fork. */
const FORK_JSON = JSON.stringify({
  version: 1,
  title: 'Fork',
  rationaleArtifact: 'task',
  entries: ['a'],
  artifacts: [
    {
      id: 'task',
      path: 'artifacts/plan/task.md',
      producer: '$planner',
      consumers: ['a'],
      mediaType: 'text/markdown',
      maxBytes: 1024,
      required: true,
    },
  ],
  nodes: [
    {
      id: 'a',
      kind: 'agent',
      label: 'Start',
      profile: 'worker',
      instructionsArtifact: 'task',
      inputs: ['task'],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked', 'replan'],
      budget: { maxVisits: 1 },
    },
    {
      id: 'f',
      kind: 'command',
      label: 'Fork',
      command: 'test',
      repositories: ['api'],
      outcomes: ['passed', 'failed', 'infrastructure-error'],
      budget: { maxVisits: 2 },
    },
    {
      id: 'b',
      kind: 'command',
      label: 'Branch b',
      command: 'test',
      repositories: ['api'],
      outcomes: ['passed', 'failed', 'infrastructure-error'],
      budget: { maxVisits: 2 },
    },
    {
      id: 'c',
      kind: 'command',
      label: 'Branch c',
      command: 'test',
      repositories: ['api'],
      outcomes: ['passed', 'failed', 'infrastructure-error'],
      budget: { maxVisits: 2 },
    },
    {
      id: 'j',
      kind: 'join',
      label: 'Join',
      forkFrom: 'f',
      waitFor: ['b', 'c'],
      mode: 'all',
      outcomes: ['complete'],
      budget: { maxVisits: 2 },
    },
  ],
  edges: [
    { id: 'a-to-f', from: 'a', on: 'complete', to: 'f' },
    { id: 'f-to-b', from: 'f', on: 'passed', to: 'b' },
    { id: 'f-to-c', from: 'f', on: 'passed', to: 'c' },
    { id: 'f-fail', from: 'f', on: 'failed', to: 'END' },
    { id: 'b-to-j', from: 'b', on: 'passed', to: 'j' },
    { id: 'b-to-j2', from: 'b', on: 'failed', to: 'j' },
    { id: 'c-to-j', from: 'c', on: 'passed', to: 'j' },
    { id: 'c-to-j2', from: 'c', on: 'failed', to: 'j' },
    { id: 'j-done', from: 'j', on: 'complete', to: 'END' },
  ],
  budgets: { maxNodeRuns: 8, maxExpertRuns: 1, maxReplans: 0 },
});

function context(overrides?: Partial<CompileContext>): CompileContext {
  return {
    profiles: new Map([
      ['worker', 'worker'],
      ['expert', 'expert'],
    ]),
    commands: new Map([
      [
        'test',
        {
          id: 'test',
          fingerprint: 'fp-test',
          access: 'write',
          timeoutSeconds: 120,
          permittedRepositories: ['api'],
        },
      ],
    ]),
    repositories: new Map([['api', { id: 'api', root: '', domain: 'domain-api' }]]),
    artifactFileExists: () => true,
    expertSpend: { spentPlannerRuns: 0, permittedReplans: 0, bootstrapUnspent: true },
    projectMaxima: { maxNodeRuns: 200, maxExpertRuns: 10, maxReplans: 5 },
    ...overrides,
  };
}

function parse(json: string): GraphDocument {
  const result = parseGraphDocument(json);
  if (!result.ok) {
    throw new Error(
      `fixture must parse: ${result.diagnostics
        .map((d) => `${d.code}@${d.where}`)
        .join(', ')}`,
    );
  }
  return result.document;
}

function compile(
  json: string,
  ctx: CompileContext = context(),
): ReturnType<typeof compileGraphDocument> {
  return compileGraphDocument(parse(json), ctx);
}

/** Expect exactly one error diagnostic of `code` at `where`. */
function expectError(
  json: string,
  code: CompileDiagnosticCode,
  where: string,
  ctx?: CompileContext,
): CompileDiagnostic {
  const result = compile(json, ctx);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected compile failure');
  const match = result.diagnostics.filter((d) => d.code === code && d.where === where);
  expect(match).toHaveLength(1);
  return match[0]!;
}

function ref(mutate?: (d: Record<string, unknown>) => void): string {
  const d = JSON.parse(REF_JSON) as Record<string, unknown>;
  mutate?.(d);
  return JSON.stringify(d);
}

describe('compileGraphDocument — the reference graph compiles', () => {
  it('compiles the reference document with a pinned canonical fingerprint', () => {
    const result = compile(REF_JSON);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.canonicalJson).toBe(
      '{"artifacts":[{"consumers":["a"],"id":"task","maxBytes":1024,"mediaType":"text/markdown","path":"artifacts/plan/task.md","producer":"$planner","required":true},{"consumers":[],"id":"result","maxBytes":1024,"mediaType":"text/markdown","path":"artifacts/results/result.md","producer":"a","required":true}],"budgets":{"maxExpertRuns":1,"maxNodeRuns":4,"maxReplans":0},"edges":[{"from":"a","id":"a-done","on":"complete","to":"v"},{"from":"v","id":"v-pass","on":"passed","to":"END"},{"from":"v","id":"v-fail","on":"failed","to":"END"}],"entries":["a"],"nodes":[{"budget":{"maxVisits":1},"id":"a","inputs":["task"],"instructionsArtifact":"task","kind":"agent","label":"Do the work","outcomes":["complete","blocked","replan"],"outputs":["result"],"profile":"worker","resources":{"reads":[],"writes":[]}},{"budget":{"maxVisits":2},"command":"test","id":"v","kind":"command","label":"Verify","outcomes":["passed","failed","infrastructure-error"],"repositories":["api"]}],"rationaleArtifact":"task","title":"Reference graph","version":1}',
    );
    expect(result.compiled.fingerprint).toBe(
      'aa5fe61e0657cd6bfa26e9463319fc45879469777cde056f08d96b37d2866e34',
    );
  });

  it('compiles the fork/join graph with same-outcome fan-out', () => {
    const result = compile(FORK_JSON);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.outgoing['f']).toHaveLength(3);
    expect(result.compiled.commandFingerprints).toEqual({ test: 'fp-test' });
  });

  it('permits reserved control/fault outcomes without edges', () => {
    // a has no edge on blocked/replan; v has none on infrastructure-error.
    const result = compile(REF_JSON);
    expect(result.ok).toBe(true);
  });

  it('permits an explicit edge on a reserved outcome', () => {
    const result = compile(
      ref((d) => {
        (d.edges as unknown[]).push({
          id: 'a-blocked',
          from: 'a',
          on: 'blocked',
          to: 'END',
        });
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('compileGraphDocument — unique ids', () => {
  it('rejects a duplicate node id', () => {
    expectError(
      ref((d) => (d.nodes as unknown[]).push((d.nodes as unknown[])[0])),
      'duplicate-node-id',
      'a',
    );
  });

  it('rejects a duplicate artifact id', () => {
    expectError(
      ref((d) => (d.artifacts as unknown[]).push((d.artifacts as unknown[])[0])),
      'duplicate-artifact-id',
      'task',
    );
  });

  it('rejects a duplicate edge id', () => {
    expectError(
      ref((d) => (d.edges as unknown[]).push((d.edges as unknown[])[0])),
      'duplicate-edge-id',
      'a-done',
    );
  });
});

describe('compileGraphDocument — entries and edges', () => {
  it('rejects empty entries', () => {
    expectError(ref((d) => (d['entries'] = [])), 'empty-entries', 'entries');
  });

  it('rejects an entry that is not a node', () => {
    expectError(ref((d) => (d['entries'] = ['zzz'])), 'unknown-entry', 'zzz');
  });

  it('rejects an edge from an unknown source', () => {
    expectError(
      ref((d) =>
        (d.edges as unknown[]).push({ id: 'e', from: 'zzz', on: 'complete', to: 'v' }),
      ),
      'unknown-edge-source',
      'e',
    );
  });

  it('rejects an edge to an unknown destination', () => {
    expectError(
      ref((d) =>
        (d.edges as unknown[]).push({ id: 'e', from: 'a', on: 'complete', to: 'zzz' }),
      ),
      'unknown-edge-destination',
      'e',
    );
  });

  it('rejects an edge firing an outcome the source does not declare', () => {
    expectError(
      ref((d) =>
        (d.edges as unknown[]).push({ id: 'e', from: 'a', on: 'passed', to: 'v' }),
      ),
      'edge-outcome-undeclared',
      'e',
    );
  });

  it('rejects a normal outcome with no outgoing edge', () => {
    expectError(
      ref((d) => {
        (d.edges as unknown[]) = ((d.edges as unknown[]) as unknown[]).filter(
          (e) => (e as { id: string }).id !== 'a-done',
        );
      }),
      'missing-normal-edge',
      'a',
    );
  });

  it('rejects a graph with no reachable END path', () => {
    expectError(
      ref((d) => {
        (d.edges as unknown[])[1] = { id: 'v-pass', from: 'v', on: 'passed', to: 'a' };
        (d.edges as unknown[])[2] = { id: 'v-fail', from: 'v', on: 'failed', to: 'a' };
      }),
      'no-end-path',
      '',
    );
  });

  it('rejects an unreachable node', () => {
    expectError(
      ref((d) =>
        (d.nodes as unknown[]).push({
          id: 'z',
          kind: 'command',
          label: 'Orphan',
          command: 'test',
          repositories: ['api'],
          outcomes: ['passed', 'failed', 'infrastructure-error'],
          budget: { maxVisits: 1 },
        }),
      ),
      'unreachable-node',
      'z',
    );
  });
});

describe('compileGraphDocument — artifacts', () => {
  it('rejects a reference to an unknown artifact', () => {
    expectError(
      ref((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        node['inputs'] = ['zzz'];
      }),
      'unknown-artifact',
      'a',
    );
  });

  it('rejects an artifact produced by an unknown node', () => {
    expectError(
      ref((d) => {
        ((d.artifacts as unknown[])[1] as Record<string, unknown>)['producer'] = 'zzz';
      }),
      'unknown-artifact-producer',
      'result',
    );
  });

  it('rejects an artifact listing an unknown consumer', () => {
    expectError(
      ref((d) => {
        ((d.artifacts as unknown[])[0] as Record<string, unknown>)['consumers'] = ['zzz'];
      }),
      'unknown-consumer',
      'task',
    );
  });

  it('rejects an output produced by another node', () => {
    expectError(
      ref((d) => {
        ((d.artifacts as unknown[])[1] as Record<string, unknown>)['producer'] = '$planner';
      }),
      'undeliverable-output',
      'a',
    );
  });

  it('rejects an artifact referenced by no node', () => {
    expectError(
      ref((d) =>
        (d.artifacts as unknown[]).push({
          id: 'orphan',
          path: 'artifacts/plan/orphan.md',
          producer: '$planner',
          consumers: [],
          mediaType: 'text/markdown',
          maxBytes: 1024,
          required: true,
        }),
      ),
      'unreferenced-artifact',
      'orphan',
    );
  });

  it('rejects a planner-produced artifact with no file at compile time', () => {
    const ctx = context({ artifactFileExists: (id) => id !== 'task' });
    expectError(ref(), 'planner-artifact-missing', 'task', ctx);
  });
});

describe('compileGraphDocument — profiles, commands, repositories', () => {
  it('rejects an unknown profile', () => {
    expectError(
      ref((d) => {
        ((d.nodes as unknown[])[0] as Record<string, unknown>)['profile'] = 'zzz';
      }),
      'unknown-profile',
      'a',
    );
  });

  it('rejects an unknown command', () => {
    expectError(
      ref((d) => {
        ((d.nodes as unknown[])[1] as Record<string, unknown>)['command'] = 'zzz';
      }),
      'unknown-command',
      'v',
    );
  });

  it('rejects a command repository that is not declared', () => {
    expectError(
      ref((d) => {
        ((d.nodes as unknown[])[1] as Record<string, unknown>)['repositories'] = ['zzz'];
      }),
      'unknown-command-repository',
      'v',
    );
  });

  it('rejects a repository the trusted command definition does not permit', () => {
    const ctx = context({
      commands: new Map([
        [
          'test',
          {
            id: 'test',
            fingerprint: 'fp-test',
            access: 'write',
            timeoutSeconds: 120,
            permittedRepositories: ['web'],
          },
        ],
      ]),
    });
    expectError(ref(), 'command-repository-not-permitted', 'v', ctx);
  });

  it('rejects a claim on an unknown repository', () => {
    expectError(
      ref((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        node['resources'] = {
          reads: [{ repo: 'zzz', paths: ['src'] }],
          writes: [],
        };
      }),
      'unknown-repository',
      'a',
    );
  });
});

describe('compileGraphDocument — gate policies', () => {
  function gateDoc(mutate?: (d: Record<string, unknown>) => void): string {
    const d = JSON.parse(REF_JSON) as Record<string, unknown>;
    (d.nodes as unknown[]).push({
      id: 'g',
      kind: 'gate',
      label: 'Check',
      policy: { kind: 'node-visits', node: 'a', op: 'lte', value: 2 },
      outcomes: ['matched', 'not-matched'],
      budget: { maxVisits: 1 },
    });
    (d.edges as unknown[]).push(
      { id: 'a-to-g', from: 'a', on: 'complete', to: 'g' },
      { id: 'g-match', from: 'g', on: 'matched', to: 'END' },
      { id: 'g-nomatch', from: 'g', on: 'not-matched', to: 'END' },
    );
    mutate?.(d);
    return JSON.stringify(d);
  }

  it('compiles a gate whose policy references valid ids', () => {
    const result = compile(gateDoc());
    expect(result.ok).toBe(true);
  });

  it('rejects a node-visits predicate on an unknown node', () => {
    expectError(
      gateDoc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        (node['policy'] as Record<string, unknown>)['node'] = 'zzz';
      }),
      'unknown-gate-node',
      'zzz',
    );
  });

  it('rejects a node-outcomes predicate with an undeclared outcome', () => {
    expectError(
      gateDoc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        node['policy'] = {
          kind: 'node-outcomes',
          node: 'a',
          outcome: 'passed',
          op: 'lte',
          value: 1,
        };
      }),
      'unknown-gate-outcome',
      'a.passed',
    );
  });

  it('rejects an artifact-exists predicate on an unknown artifact', () => {
    expectError(
      gateDoc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        node['policy'] = { kind: 'artifact-exists', artifact: 'zzz' };
      }),
      'unknown-gate-artifact',
      'zzz',
    );
  });
});

describe('compileGraphDocument — budgets', () => {
  it('rejects the expert-budget rule when an expert node exceeds it', () => {
    expectError(
      ref((d) => {
        ((d.nodes as unknown[])[0] as Record<string, unknown>)['profile'] = 'expert';
        const budget = ((d.nodes as unknown[])[0] as Record<string, unknown>)[
          'budget'
        ] as Record<string, unknown>;
        budget['maxVisits'] = 2;
      }),
      'expert-budget-exceeded',
      'budgets.maxExpertRuns',
    );
  });

  it('rejects a declared budget above the project maximum', () => {
    const ctx = context({ projectMaxima: { maxNodeRuns: 3, maxExpertRuns: 10, maxReplans: 5 } });
    expectError(ref(), 'budget-exceeds-project-maximum', 'budgets.maxNodeRuns', ctx);
  });
});

describe('compileGraphDocument — fork/join structure', () => {
  it('compiles the structured fork/join graph', () => {
    const result = compile(FORK_JSON);
    expect(result.ok).toBe(true);
  });

  it('rejects a join whose fork does not exist', () => {
    expectError(
      FORK_JSON.replace('"forkFrom":"f"', '"forkFrom":"zzz"'),
      'join-unknown-fork',
      'j',
    );
  });

  it('rejects a join waiting for an unknown node', () => {
    expectError(
      FORK_JSON.replace('"waitFor":["b","c"]', '"waitFor":["b","zzz"]'),
      'join-unknown-branch',
      'j',
    );
  });

  it('rejects a fork that does not dominate a branch', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['entries'] as unknown[]) = ['a', 'c'];
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'join-fork-not-dominating')).toBe(true);
  });

  it('rejects a join that does not post-dominate a branch', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['nodes'] as unknown[]).push({
      id: 'e',
      kind: 'agent',
      label: 'Escape',
      profile: 'worker',
      instructionsArtifact: 'task',
      inputs: ['task'],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked', 'replan'],
      budget: { maxVisits: 1 },
    });
    (d['edges'] as unknown[]).push(
      { id: 'b-esc', from: 'b', on: 'infrastructure-error', to: 'e' },
      { id: 'e-end', from: 'e', on: 'complete', to: 'END' },
    );
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'join-not-post-dominating')).toBe(true);
  });

  it('rejects a conditional node on a fork-to-branch path', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['nodes'] as unknown[]).push({
      id: 'x',
      kind: 'gate',
      label: 'Conditional',
      policy: { kind: 'node-visits', node: 'f', op: 'lte', value: 5 },
      outcomes: ['matched', 'not-matched'],
      budget: { maxVisits: 1 },
    });
    (d['edges'] as unknown[]).push(
      { id: 'f-to-x', from: 'f', on: 'passed', to: 'x' },
      { id: 'x-to-b', from: 'x', on: 'matched', to: 'b' },
      { id: 'x-other', from: 'x', on: 'not-matched', to: 'END' },
      { id: 'f-fail', from: 'f', on: 'failed', to: 'END' },
    );
    (d['edges'] as unknown[]) = ((d['edges'] as unknown[]) as unknown[]).filter(
      (e) =>
        (e as { id: string }).id !== 'f-to-b' &&
        (e as { id: string }).id !== 'f-to-c' &&
        (e as { id: string }).id !== 'f-fail',
    );
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'join-conditional-branch')).toBe(true);
  });

  it('rejects a branch whose normal outcome routes away from the join', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['edges'] as unknown[]) = ((d['edges'] as unknown[]) as unknown[]).map((e) => {
      const edge = e as { id: string; to: string };
      if (edge.id === 'b-to-j2') return { ...edge, to: 'END' };
      return edge;
    });
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'join-conditional-arrival')).toBe(true);
  });

  it('rejects a branch that fans out two arrivals to the join on one outcome', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['edges'] as unknown[]).push({ id: 'b-to-j3', from: 'b', on: 'passed', to: 'j' });
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'join-branch-fanout')).toBe(true);
  });

  it('rejects a join whose incoming edges do not match its branches', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['nodes'] as unknown[]).push({
      id: 'x',
      kind: 'command',
      label: 'Extra feeder',
      command: 'test',
      repositories: ['api'],
      outcomes: ['passed', 'failed', 'infrastructure-error'],
      budget: { maxVisits: 1 },
    });
    (d['edges'] as unknown[]).push(
      { id: 'a-to-x', from: 'a', on: 'complete', to: 'x' },
      { id: 'x-to-j', from: 'x', on: 'passed', to: 'j' },
      { id: 'x-to-j2', from: 'x', on: 'failed', to: 'j' },
    );
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'join-predecessor-mismatch')).toBe(true);
  });

  it('rejects a join region inside a strongly connected component', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['edges'] as unknown[]).push({ id: 'j-to-b', from: 'j', on: 'complete', to: 'b' });
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'join-region-in-scc')).toBe(true);
  });

  it('rejects a branch declared by two joins', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    (d['nodes'] as unknown[]).push({
      id: 'j2',
      kind: 'join',
      label: 'Second join',
      forkFrom: 'f',
      waitFor: ['b'],
      mode: 'all',
      outcomes: ['complete'],
      budget: { maxVisits: 1 },
    });
    (d['edges'] as unknown[]).push({ id: 'j2-done', from: 'j2', on: 'complete', to: 'END' });
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((x) => x.code === 'ambiguous-join-region')).toBe(true);
  });

  it('rejects a join budgeted below its fork multiplicity', () => {
    const d = JSON.parse(FORK_JSON) as Record<string, unknown>;
    const j = (d['nodes'] as unknown[]).find((n) => (n as { id: string }).id === 'j') as Record<
      string,
      unknown
    >;
    (j['budget'] as Record<string, unknown>)['maxVisits'] = 1;
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.diagnostics.some((x) => x.code === 'join-budget-below-fork-multiplicity'),
    ).toBe(true);
  });
});

describe('compileGraphDocument — overlaps and the serialization warning', () => {
  function overlapDoc(
    mutators: Array<(a: Record<string, unknown>, b: Record<string, unknown>) => void>,
  ): string {
    const d = JSON.parse(REF_JSON) as Record<string, unknown>;
    const nodes = d['nodes'] as unknown[];
    const a = nodes[0] as Record<string, unknown>;
    const b = {
      id: 'b',
      kind: 'agent',
      label: 'Second writer',
      profile: 'worker',
      instructionsArtifact: 'task',
      inputs: ['task'],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked', 'replan'],
      budget: { maxVisits: 1 },
    };
    nodes.push(b);
    (d['edges'] as unknown[]).push(
      { id: 'a-to-b', from: 'a', on: 'complete', to: 'b' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    );
    (d['budgets'] as Record<string, unknown>)['maxNodeRuns'] = 5;
    for (const mutate of mutators) mutate(a, b);
    return JSON.stringify(d);
  }

  it('records write/write and write/read overlaps for scheduler serialization', () => {
    const json = overlapDoc([
      (a) => {
        a['resources'] = {
          reads: [{ repo: 'api', paths: ['src'] }],
          writes: [{ repo: 'api', paths: ['src'] }],
        };
      },
      (_a, b) => {
        b['resources'] = {
          reads: [],
          writes: [{ repo: 'api', paths: ['src/api'] }],
        };
      },
    ]);
    const result = compile(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.overlaps).toContainEqual({
      a: 'a',
      b: 'b',
      domain: 'domain-api',
      path: 'src/api',
    });
    expect(result.compiled.warnings).toHaveLength(0);
  });

  it('does not overlap read-only claims on the same path', () => {
    const json = overlapDoc([
      (a) => {
        a['resources'] = {
          reads: [{ repo: 'api', paths: ['src'] }],
          writes: [],
        };
      },
      (_a, b) => {
        b['resources'] = {
          reads: [{ repo: 'api', paths: ['src'] }],
          writes: [],
        };
      },
    ]);
    const result = compile(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const agentPair = result.compiled.overlaps.filter(
      (o) =>
        (o.a === 'a' && o.b === 'b') || (o.a === 'b' && o.b === 'a'),
    );
    expect(agentPair).toHaveLength(0);
    // The repository-wide write command still conflicts with both readers.
    expect(result.compiled.overlaps.length).toBeGreaterThan(0);
  });

  it('emits the serialization warning without failing compilation', () => {
    const json = overlapDoc([
      (a) => {
        a['resources'] = { reads: [], writes: [{ repo: 'api', paths: ['src'] }] };
      },
      (_a, b) => {
        b['resources'] = { reads: [], writes: [{ repo: 'api', paths: ['src'] }] };
      },
    ]);
    const d = JSON.parse(json) as Record<string, unknown>;
    (d['nodes'] as unknown[]).push({
      id: 'c',
      kind: 'agent',
      label: 'Third writer',
      profile: 'worker',
      instructionsArtifact: 'task',
      inputs: ['task'],
      outputs: [],
      resources: { reads: [], writes: [{ repo: 'api', paths: ['src'] }] },
      outcomes: ['complete', 'blocked', 'replan'],
      budget: { maxVisits: 1 },
    });
    (d['edges'] as unknown[]).push(
      { id: 'a-to-c', from: 'a', on: 'complete', to: 'c' },
      { id: 'c-end', from: 'c', on: 'complete', to: 'END' },
    );
    (d['budgets'] as Record<string, unknown>)['maxNodeRuns'] = 6;
    const result = compile(JSON.stringify(d));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.compiled.warnings.find((w) => w.code === 'warn-serialized-plan');
    expect(warning).toBeDefined();
  });
});

describe('compileGraphDocument — fork-lineage depth bound (Slice 5 T4)', () => {
  /** A loop chain: `count` agents, each self-looping (maxVisits each) and
   *  exiting to the next; the deepest lineage stack it can produce is
   *  `1 + count × (maxVisits - 1)`. */
  function loopChain(count: number, maxVisits: number): string {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      kind: 'agent',
      label: `Loop ${i}`,
      profile: 'worker',
      instructionsArtifact: 'task',
      inputs: ['task'],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked', 'replan'],
      budget: { maxVisits },
    }));
    const edges: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      edges.push({ id: `self${i}`, from: `n${i}`, on: 'complete', to: `n${i}` });
      if (i + 1 < count) {
        edges.push({ id: `next${i}`, from: `n${i}`, on: 'complete', to: `n${i + 1}` });
      }
    }
    edges.push({ id: 'last-end', from: `n${count - 1}`, on: 'complete', to: 'END' });
    return JSON.stringify({
      version: 1,
      title: 'Loop chain',
      rationaleArtifact: 'task',
      entries: ['n0'],
      artifacts: [
        {
          id: 'task',
          path: 'artifacts/plan/task.md',
          producer: '$planner',
          consumers: nodes.map((n) => n.id),
          mediaType: 'text/markdown',
          maxBytes: 1024,
          required: true,
        },
      ],
      nodes,
      edges,
      budgets: { maxNodeRuns: 200, maxExpertRuns: 10, maxReplans: 5 },
    });
  }

  it('a single loop well within the bound compiles', () => {
    const result = compile(loopChain(1, 20));
    expect(result.ok).toBe(true);
  });

  it('a loop chain deeper than the bound fails compilation', () => {
    // 5 nested loops of maxVisits 20 → deepest lineage depth 1 + 5×19 = 96,
    // beyond GRAPH_LIMITS.maxLineageDepth (64).
    const diagnostic = expectError(loopChain(5, 20), 'lineage-depth-exceeded', 'fork lineage');
    expect(diagnostic.message).toMatch(/96.*beyond the bound 64/);
  });
});
