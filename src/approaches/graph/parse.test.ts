/**
 * Pure parser for the generated graph document (Slice 2 Task 3).
 *
 * The planner's output is untrusted data; this parser is the closed boundary
 * every High-severity injection and coercion class lands on. Each malformed
 * document below asserts a NAMED diagnostic — a table of malformed documents,
 * one per rule; a fuzz-style table of numeric edge cases; the reserved
 * sentinels; a document with an unknown field at every nesting level.
 */

import { describe, it, expect } from 'vitest';
import { parseGraphDocument, type GraphParseDiagnostic } from './parse.js';

/** A minimal valid document exercising every node kind and predicate shape. */
function validDocument(): Record<string, unknown> {
  return {
    version: 1,
    title: 'Implement provider-aware session switching',
    rationaleArtifact: 'architecture-notes',
    entries: ['implement-api', 'implement-web'],
    artifacts: [
      {
        id: 'architecture-notes',
        path: 'artifacts/plan/architecture.md',
        producer: '$planner',
        consumers: [],
        mediaType: 'text/markdown',
        maxBytes: 262144,
        required: true,
      },
      {
        id: 'api-task',
        path: 'artifacts/tasks/api.md',
        producer: '$planner',
        consumers: ['implement-api'],
        mediaType: 'text/markdown',
        maxBytes: 131072,
        required: true,
      },
    ],
    nodes: [
      {
        id: 'implement-api',
        kind: 'agent',
        label: 'Implement API changes',
        profile: 'worker',
        instructionsArtifact: 'api-task',
        inputs: ['api-task'],
        outputs: ['api-result'],
        resources: {
          reads: [{ repo: 'api', paths: ['src'] }],
          writes: [{ repo: 'api', paths: ['src/api', 'test/api'] }],
        },
        outcomes: ['complete', 'blocked', 'replan'],
        budget: { maxVisits: 1 },
      },
      {
        id: 'verify',
        kind: 'command',
        label: 'Run repository tests',
        command: 'test',
        repositories: ['api'],
        outcomes: ['passed', 'failed', 'infrastructure-error'],
        budget: { maxVisits: 3 },
      },
      {
        id: 'gate-cheap',
        kind: 'gate',
        label: 'Check the budget',
        policy: { kind: 'node-visits', node: 'implement-api', op: 'lte', value: 1 },
        outcomes: ['matched', 'not-matched'],
        budget: { maxVisits: 1 },
      },
      {
        id: 'join-implementation',
        kind: 'join',
        label: 'Wait for implementation branches',
        forkFrom: '$entry',
        waitFor: ['implement-api', 'implement-web'],
        mode: 'all',
        outcomes: ['complete'],
        budget: { maxVisits: 1 },
      },
    ],
    edges: [
      { id: 'api-to-join', from: 'implement-api', on: 'complete', to: 'join-implementation' },
      { id: 'verify-passed', from: 'verify', on: 'passed', to: 'END' },
      { id: 'gate-to-end', from: 'gate-cheap', on: 'matched', to: 'END' },
    ],
    budgets: { maxNodeRuns: 20, maxExpertRuns: 2, maxReplans: 1 },
  };
}

/** Serialize a (possibly mutated) valid document. */
function doc(mutate?: (d: Record<string, unknown>) => void): string {
  const d = validDocument();
  mutate?.(d);
  return JSON.stringify(d);
}

/** Expect `input` to parse with exactly one diagnostic of code `code` at `where`. */
function expectDiagnostic(
  input: string,
  code: GraphParseDiagnostic['code'],
  where: string,
): GraphParseDiagnostic {
  const result = parseGraphDocument(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected parse failure');
  const match = result.diagnostics.filter((d) => d.code === code && d.where === where);
  expect(match).toHaveLength(1);
  return match[0]!;
}

describe('parseGraphDocument — valid documents', () => {
  it('parses the reference document into typed structures', () => {
    const result = parseGraphDocument(doc());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(1);
    expect(result.document.title).toBe('Implement provider-aware session switching');
    expect(result.document.entries).toEqual(['implement-api', 'implement-web']);
    expect(result.document.artifacts).toHaveLength(2);
    expect(result.document.artifacts[0]).toMatchObject({
      id: 'architecture-notes',
      producer: '$planner',
      mediaType: 'text/markdown',
      required: true,
    });
    expect(result.document.nodes).toHaveLength(4);
    expect(result.document.nodes[0]).toMatchObject({ id: 'implement-api', kind: 'agent' });
    expect(result.document.nodes[1]).toMatchObject({ id: 'verify', kind: 'command' });
    expect(result.document.nodes[2]).toMatchObject({ id: 'gate-cheap', kind: 'gate' });
    expect(result.document.nodes[3]).toMatchObject({ id: 'join-implementation', kind: 'join' });
    expect(result.document.edges).toHaveLength(3);
    expect(result.document.budgets).toEqual({ maxNodeRuns: 20, maxExpertRuns: 2, maxReplans: 1 });
  });

  it('accepts the END sentinel as an edge destination', () => {
    const result = parseGraphDocument(doc());
    expect(result.ok).toBe(true);
  });

  it('normalizes artifact and resource paths to relative canonical form', () => {
    const result = parseGraphDocument(doc());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.artifacts[0]!.path).toBe('artifacts/plan/architecture.md');
    const agent = result.document.nodes[0];
    if (agent?.kind !== 'agent') throw new Error('expected agent node');
    expect(agent.resources.writes[0]!.paths).toEqual(['src/api', 'test/api']);
  });
});

describe('parseGraphDocument — unknown fields are rejected, never ignored', () => {
  it('rejects an unknown field at the document root', () => {
    expectDiagnostic(doc((d) => (d['futureField'] = 1)), 'unknown-field', '');
  });

  it('rejects an unknown field on an artifact', () => {
    expectDiagnostic(
      doc((d) => ((d.artifacts as unknown[])[0] as Record<string, unknown>)['staging'] = 'x'),
      'unknown-field',
      'artifacts[0]',
    );
  });

  it('rejects an unknown field on an agent node', () => {
    expectDiagnostic(
      doc((d) => ((d.nodes as unknown[])[0] as Record<string, unknown>)['coerce'] = true),
      'unknown-field',
      'nodes[0]',
    );
  });

  it('rejects an unknown field on a command node', () => {
    expectDiagnostic(
      doc((d) => ((d.nodes as unknown[])[1] as Record<string, unknown>)['arguments'] = ['-x']),
      'unknown-field',
      'nodes[1]',
    );
  });

  it('rejects an unknown field on a gate policy', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        (node['policy'] as Record<string, unknown>)['expression'] = 'x > 1';
      }),
      'unknown-field',
      'nodes[2].policy',
    );
  });

  it('rejects an unknown field on a resource claim', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        const resources = node['resources'] as Record<string, unknown>;
        ((resources['reads'] as unknown[])[0] as Record<string, unknown>)['glob'] = 'src/*';
      }),
      'unknown-field',
      'nodes[0].resources.reads[0]',
    );
  });

  it('rejects an unknown field on an edge', () => {
    expectDiagnostic(
      doc((d) => ((d.edges as unknown[])[0] as Record<string, unknown>)['priority'] = 1),
      'unknown-field',
      'edges[0]',
    );
  });

  it('rejects an unknown field on the budgets block', () => {
    expectDiagnostic(
      doc((d) => ((d.budgets as Record<string, unknown>)['maxActivations'] = 1000)),
      'unknown-field',
      'budgets',
    );
  });

  it('rejects unknown fields at every nesting level at once', () => {
    const input = doc((d) => {
      d['rootExtra'] = 1;
      ((d.artifacts as unknown[])[0] as Record<string, unknown>)['artifactExtra'] = 1;
      const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
      node['nodeExtra'] = 1;
      const resources = node['resources'] as Record<string, unknown>;
      ((resources['writes'] as unknown[])[0] as Record<string, unknown>)['claimExtra'] = 1;
      (d.edges as unknown[])[0] as Record<string, unknown>;
    });
    const result = parseGraphDocument(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const wheres = result.diagnostics.filter((x) => x.code === 'unknown-field').map((x) => x.where);
    expect(wheres).toContain('');
    expect(wheres).toContain('artifacts[0]');
    expect(wheres).toContain('nodes[0]');
    expect(wheres).toContain('nodes[0].resources.writes[0]');
  });
});

describe('parseGraphDocument — the bounded safe-identifier grammar', () => {
  it.each([
    ['uppercase letter', 'Implement-API'],
    ['leading digit', '1abc'],
    ['leading hyphen', '-abc'],
    ['space', 'a b'],
    ['shell metacharacters', 'a;b'],
    ['quotes', 'a"b'],
    ['empty string', ''],
    ['over 64 characters', 'a'.repeat(65)],
    ['dollar prefix', '$abc'],
  ])('rejects a node id with %s', (_what, id) => {
    expectDiagnostic(
      doc((d) => (((d.nodes as unknown[])[0] as Record<string, unknown>)['id'] = id)),
      'invalid-identifier',
      'nodes[0].id',
    );
  });

  it.each([
    ['$planner', '$planner'],
    ['$entry', '$entry'],
  ])('rejects reserved sentinel %s as a user node id', (_what, id) => {
    expectDiagnostic(
      doc((d) => (((d.nodes as unknown[])[0] as Record<string, unknown>)['id'] = id)),
      'reserved-identifier',
      'nodes[0].id',
    );
  });

  it.each([
    ['artifact', 'artifacts[0].id'],
    ['edge', 'edges[0].id'],
    ['profile', 'nodes[0].profile'],
    ['repository', 'nodes[0].resources.reads[0].repo'],
    ['command', 'nodes[1].command'],
    ['instructionsArtifact', 'nodes[0].instructionsArtifact'],
    ['input', 'nodes[0].inputs[0]'],
    ['output', 'nodes[0].outputs[0]'],
    ['consumer', 'artifacts[0].consumers[0]'],
    ['entry', 'entries[0]'],
    ['waitFor', 'nodes[3].waitFor[0]'],
    ['forkFrom', 'nodes[3].forkFrom'],
  ])('rejects a reserved sentinel in %s position', (_what, where) => {
    const input = doc((d) => {
      let cursor: Record<string, unknown> = d;
      const parts = where.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        const m = /^(.+)\[(\d+)\]$/.exec(part);
        if (m) {
          cursor = (cursor[m[1]!] as unknown[])[Number(m[2])] as Record<string, unknown>;
        } else {
          cursor = cursor[part] as Record<string, unknown>;
        }
      }
      const last = parts[parts.length - 1]!;
      const lastM = /^(.+)\[(\d+)\]$/.exec(last);
      if (lastM) {
        (cursor[lastM[1]!] as unknown[])[Number(lastM[2])] = '$planner';
      } else {
        cursor[last] = '$planner';
      }
    });
    expectDiagnostic(input, 'reserved-identifier', where);
  });

  it('accepts $planner as an artifact producer and $entry as a join forkFrom', () => {
    const result = parseGraphDocument(doc());
    expect(result.ok).toBe(true);
  });
});

describe('parseGraphDocument — numeric values', () => {
  it.each([
    ['a fraction', 1.5, 'invalid-number'],
    ['a string', '3', 'invalid-number'],
    ['a boolean', true, 'invalid-number'],
    ['null', null, 'invalid-number'],
    ['NaN', Number.NaN, 'invalid-number'],
    ['an object', {}, 'invalid-number'],
    ['a negative', -1, 'number-out-of-range'],
    ['zero below min', 0, 'number-out-of-range'],
    ['above the max', 21, 'number-out-of-range'],
  ] as const)('rejects maxVisits = %s', (_what, value, code) => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        (node['budget'] as Record<string, unknown>)['maxVisits'] = value;
      }),
      code,
      'nodes[0].budget.maxVisits',
    );
  });

  it.each([
    ['a fraction', 1.5, 'invalid-number'],
    ['a string', '2', 'invalid-number'],
    ['a negative', -1, 'number-out-of-range'],
    ['zero below min', 0, 'number-out-of-range'],
    ['above the max', 201, 'number-out-of-range'],
  ] as const)('rejects budgets.maxNodeRuns = %s', (_what, value, code) => {
    expectDiagnostic(
      doc((d) => (((d.budgets as Record<string, unknown>)['maxNodeRuns']) = value)),
      code,
      'budgets.maxNodeRuns',
    );
  });

  it.each([
    ['a fraction', 2.5, 'invalid-number'],
    ['above the max', 11, 'number-out-of-range'],
  ] as const)('rejects budgets.maxExpertRuns = %s', (_what, value, code) => {
    expectDiagnostic(
      doc((d) => (((d.budgets as Record<string, unknown>)['maxExpertRuns']) = value)),
      code,
      'budgets.maxExpertRuns',
    );
  });

  it.each([
    ['a negative', -1, 'number-out-of-range'],
    ['above the max', 6, 'number-out-of-range'],
  ] as const)('rejects budgets.maxReplans = %s', (_what, value, code) => {
    expectDiagnostic(
      doc((d) => (((d.budgets as Record<string, unknown>)['maxReplans']) = value)),
      code,
      'budgets.maxReplans',
    );
  });

  it.each([
    ['a fraction', 1024.5, 'invalid-number'],
    ['a string', '1024', 'invalid-number'],
    ['zero', 0, 'number-out-of-range'],
    ['a negative', -1, 'number-out-of-range'],
  ] as const)('rejects artifact maxBytes = %s', (_what, value, code) => {
    expectDiagnostic(
      doc((d) => (((d.artifacts as unknown[])[0] as Record<string, unknown>)['maxBytes']) = value),
      code,
      'artifacts[0].maxBytes',
    );
  });

  it('rejects a gate predicate value outside the bounded range', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        (node['policy'] as Record<string, unknown>)['value'] = 1001;
      }),
      'number-out-of-range',
      'nodes[2].policy.value',
    );
  });

  it('rejects an unknown gate operator', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        (node['policy'] as Record<string, unknown>)['op'] = '==';
      }),
      'invalid-operator',
      'nodes[2].policy.op',
    );
  });

  it('rejects a gate predicate value that is not a finite safe integer', () => {
    const input = doc((d) => {
      const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
      (node['policy'] as Record<string, unknown>)['value'] = Number.MAX_SAFE_INTEGER + 2;
    });
    expectDiagnostic(input, 'invalid-number', 'nodes[2].policy.value');
  });
});

describe('parseGraphDocument — collections and strings are bounded', () => {
  it.each([
    ['entries', 'entries', 21],
    ['artifacts', 'artifacts', 201],
    ['nodes', 'nodes', 201],
    ['edges', 'edges', 1001],
  ])('rejects an oversized %s collection', (_what, key, size) => {
    const input = doc((d) => {
      const coll = d[key] as unknown[];
      while (coll.length < size) coll.push(coll[0]);
    });
    expectDiagnostic(input, 'collection-too-large', key);
  });

  it('rejects an oversized artifact consumers list', () => {
    expectDiagnostic(
      doc((d) => {
        const consumers = ((d.artifacts as unknown[])[0] as Record<string, unknown>)[
          'consumers'
        ] as unknown[];
        for (let i = 0; i < 21; i++) consumers.push(`node-${i}`);
      }),
      'collection-too-large',
      'artifacts[0].consumers',
    );
  });

  it('rejects an oversized node inputs list', () => {
    expectDiagnostic(
      doc((d) => {
        const inputs = ((d.nodes as unknown[])[0] as Record<string, unknown>)[
          'inputs'
        ] as unknown[];
        for (let i = 0; i < 21; i++) inputs.push(`artifact-${i}`);
      }),
      'collection-too-large',
      'nodes[0].inputs',
    );
  });

  it('rejects an oversized node outcomes list', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        node['outcomes'] = ['complete', 'blocked', 'replan', 'complete', 'blocked'];
      }),
      'collection-too-large',
      'nodes[0].outcomes',
    );
  });

  it('rejects an oversized waitFor list', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[3] as Record<string, unknown>;
        const waitFor = node['waitFor'] as unknown[];
        for (let i = 0; i < 21; i++) waitFor.push(`node-${i}`);
      }),
      'collection-too-large',
      'nodes[3].waitFor',
    );
  });

  it('rejects an oversized resources paths list', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        const resources = node['resources'] as Record<string, unknown>;
        const paths = ((resources['reads'] as unknown[])[0] as Record<string, unknown>)[
          'paths'
        ] as unknown[];
        for (let i = 0; i < 21; i++) paths.push(`src/dir-${i}`);
      }),
      'collection-too-large',
      'nodes[0].resources.reads[0].paths',
    );
  });

  it('rejects an oversized reads claims list', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        const resources = node['resources'] as Record<string, unknown>;
        const reads = resources['reads'] as unknown[];
        for (let i = 0; i < 21; i++) reads.push({ repo: 'api', paths: ['src'] });
      }),
      'collection-too-large',
      'nodes[0].resources.reads',
    );
  });

  it('rejects a bounded string that is too long (label)', () => {
    expectDiagnostic(
      doc((d) => (((d.nodes as unknown[])[0] as Record<string, unknown>)['label']) = 'x'.repeat(201)),
      'string-too-long',
      'nodes[0].label',
    );
  });

  it('rejects a title that is too long', () => {
    expectDiagnostic(doc((d) => (d['title'] = 'x'.repeat(201))), 'string-too-long', 'title');
  });

  it('rejects a non-string bounded string field', () => {
    expectDiagnostic(
      doc((d) => (((d.nodes as unknown[])[0] as Record<string, unknown>)['label']) = 42),
      'invalid-string',
      'nodes[0].label',
    );
  });

  it('rejects a composite gate predicate deeper than the bound', () => {
    const input = doc((d) => {
      const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
      let policy: Record<string, unknown> = { kind: 'all', predicates: [] };
      let cursor = policy;
      for (let depth = 1; depth < 7; depth++) {
        cursor['predicates'] = [{ kind: 'all', predicates: [] }];
        cursor = (cursor['predicates'] as Record<string, unknown>[])[0]!;
      }
      cursor['predicates'] = [{ kind: 'artifact-exists', artifact: 'api-task' }];
      node['policy'] = policy;
    });
    expectDiagnostic(input, 'predicate-depth-exceeded', 'nodes[2].policy');
  });

  it('rejects a composite gate predicate collection larger than the bound', () => {
    const input = doc((d) => {
      const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
      node['policy'] = {
        kind: 'all',
        predicates: Array.from({ length: 21 }, () => ({
          kind: 'artifact-exists',
          artifact: 'api-task',
        })),
      };
    });
    expectDiagnostic(input, 'predicate-collection-too-large', 'nodes[2].policy');
  });

  it('rejects an unsupported gate predicate kind', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        node['policy'] = { kind: 'expression', expression: 'true' };
      }),
      'invalid-policy-kind',
      'nodes[2].policy',
    );
  });

  it('rejects an unknown policy leaf field', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        node['policy'] = { kind: 'artifact-exists', artifact: 'api-task', threshold: 1 };
      }),
      'unknown-field',
      'nodes[2].policy',
    );
  });
});

describe('parseGraphDocument — node kinds and outcomes are closed sets', () => {
  it('rejects an unsupported node kind', () => {
    expectDiagnostic(
      doc((d) => (((d.nodes as unknown[])[0] as Record<string, unknown>)['kind']) = 'shell'),
      'invalid-kind',
      'nodes[0].kind',
    );
  });

  it('rejects an outcome outside the agent set', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        node['outcomes'] = ['complete', 'passed'];
      }),
      'invalid-outcome',
      'nodes[0].outcomes[1]',
    );
  });

  it('rejects an outcome outside the command set', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[1] as Record<string, unknown>;
        node['outcomes'] = ['passed', 'blocked'];
      }),
      'invalid-outcome',
      'nodes[1].outcomes[1]',
    );
  });

  it('rejects an outcome outside the gate set', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[2] as Record<string, unknown>;
        node['outcomes'] = ['matched', 'complete'];
      }),
      'invalid-outcome',
      'nodes[2].outcomes[1]',
    );
  });

  it('rejects an outcome outside the join set', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[3] as Record<string, unknown>;
        node['outcomes'] = ['complete', 'blocked'];
      }),
      'invalid-outcome',
      'nodes[3].outcomes[1]',
    );
  });

  it('rejects a join with an unsupported mode', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[3] as Record<string, unknown>;
        node['mode'] = 'any';
      }),
      'invalid-mode',
      'nodes[3].mode',
    );
  });

  it('rejects a command node carrying provider/model/effort', () => {
    const node = (d: Record<string, unknown>) => {
      const n = (d.nodes as unknown[])[1] as Record<string, unknown>;
      n['provider'] = 'openai';
    };
    expectDiagnostic(doc(node), 'generated-config-forbidden', 'nodes[1].provider');
  });

  it('rejects an agent node carrying a model', () => {
    const node = (d: Record<string, unknown>) => {
      const n = (d.nodes as unknown[])[0] as Record<string, unknown>;
      n['model'] = 'gpt-5';
    };
    expectDiagnostic(doc(node), 'generated-config-forbidden', 'nodes[0].model');
  });

  it('rejects an agent node carrying an effort', () => {
    const node = (d: Record<string, unknown>) => {
      const n = (d.nodes as unknown[])[0] as Record<string, unknown>;
      n['effort'] = 'high';
    };
    expectDiagnostic(doc(node), 'generated-config-forbidden', 'nodes[0].effort');
  });
});

describe('parseGraphDocument — document-level shape', () => {
  it.each([
    ['a string', '"hello"'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a number', '42'],
  ])('rejects a root that is %s', (_what, input) => {
    expectDiagnostic(input, 'root-not-object', '');
  });

  it('rejects a document larger than the size bound', () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    expectDiagnostic(`{"version":1,"title":"${big}"}`, 'document-too-large', '');
  });

  it('rejects a document that is not valid JSON', () => {
    expectDiagnostic('{not json', 'invalid-json', '');
  });

  it('rejects an unsupported document version', () => {
    expectDiagnostic(doc((d) => (d['version'] = 2)), 'unsupported-version', 'version');
  });

  it('rejects a non-integer document version', () => {
    expectDiagnostic(doc((d) => (d['version'] = '1')), 'unsupported-version', 'version');
  });

  it('rejects a missing version field', () => {
    expectDiagnostic(doc((d) => delete d['version']), 'missing-field', 'version');
  });

  it('rejects a missing entries field', () => {
    expectDiagnostic(doc((d) => delete d['entries']), 'missing-field', 'entries');
  });

  it('rejects a missing budgets block', () => {
    expectDiagnostic(doc((d) => delete d['budgets']), 'missing-field', 'budgets');
  });

  it('rejects a missing nodes array', () => {
    expectDiagnostic(doc((d) => delete d['nodes']), 'missing-field', 'nodes');
  });

  it('rejects a missing edges array', () => {
    expectDiagnostic(doc((d) => delete d['edges']), 'missing-field', 'edges');
  });

  it('rejects a missing artifacts array', () => {
    expectDiagnostic(doc((d) => delete d['artifacts']), 'missing-field', 'artifacts');
  });

  it('rejects a missing node budget', () => {
    expectDiagnostic(
      doc((d) => {
        const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
        delete node['budget'];
      }),
      'missing-field',
      'nodes[0].budget',
    );
  });

  it('rejects an artifact with a missing producer', () => {
    expectDiagnostic(
      doc((d) => {
        const artifact = (d.artifacts as unknown[])[0] as Record<string, unknown>;
        delete artifact['producer'];
      }),
      'missing-field',
      'artifacts[0].producer',
    );
  });

  it('rejects an unsupported media type', () => {
    expectDiagnostic(
      doc((d) => {
        const artifact = (d.artifacts as unknown[])[0] as Record<string, unknown>;
        artifact['mediaType'] = 'text/html';
      }),
      'invalid-media-type',
      'artifacts[0].mediaType',
    );
  });

  it('rejects a non-boolean required flag', () => {
    expectDiagnostic(
      doc((d) => {
        const artifact = (d.artifacts as unknown[])[0] as Record<string, unknown>;
        artifact['required'] = 'yes';
      }),
      'invalid-boolean',
      'artifacts[0].required',
    );
  });
});

describe('parseGraphDocument — path rules', () => {
  it.each([
    ['an absolute artifact path', (d: Record<string, unknown>) => {
      ((d.artifacts as unknown[])[0] as Record<string, unknown>)['path'] = '/etc/plan.md';
    }, 'artifacts[0].path', 'invalid-path'],
    ['a parent traversal artifact path', (d: Record<string, unknown>) => {
      ((d.artifacts as unknown[])[0] as Record<string, unknown>)['path'] = 'a/../b.md';
    }, 'artifacts[0].path', 'invalid-path'],
    ['a Windows drive artifact path', (d: Record<string, unknown>) => {
      ((d.artifacts as unknown[])[0] as Record<string, unknown>)['path'] = 'C:\\plan.md';
    }, 'artifacts[0].path', 'windows-path-alias'],
    ['an absolute resource path', (d: Record<string, unknown>) => {
      const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
      const resources = node['resources'] as Record<string, unknown>;
      ((resources['reads'] as unknown[])[0] as Record<string, unknown>)['paths'] = ['/src'];
    }, 'nodes[0].resources.reads[0].paths[0]', 'invalid-path'],
    ['a traversal resource path', (d: Record<string, unknown>) => {
      const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
      const resources = node['resources'] as Record<string, unknown>;
      ((resources['reads'] as unknown[])[0] as Record<string, unknown>)['paths'] = ['src/../etc'];
    }, 'nodes[0].resources.reads[0].paths[0]', 'invalid-path'],
    ['a glob resource path', (d: Record<string, unknown>) => {
      const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
      const resources = node['resources'] as Record<string, unknown>;
      ((resources['reads'] as unknown[])[0] as Record<string, unknown>)['paths'] = ['src/*'];
    }, 'nodes[0].resources.reads[0].paths[0]', 'glob-path'],
    ['a Windows alias resource path', (d: Record<string, unknown>) => {
      const node = (d.nodes as unknown[])[0] as Record<string, unknown>;
      const resources = node['resources'] as Record<string, unknown>;
      ((resources['reads'] as unknown[])[0] as Record<string, unknown>)['paths'] = ['con'];
    }, 'nodes[0].resources.reads[0].paths[0]', 'windows-path-alias'],
  ] as const)('rejects %s', (_what, mutate, where, code) => {
    expectDiagnostic(doc(mutate), code, where);
  });
});
