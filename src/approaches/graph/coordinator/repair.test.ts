/**
 * Compile repair loop (Slice 2 Task 9): three attempts then
 * `graph-plan-invalid`; the planner-run and expert-run counters are unchanged
 * across all three; the diagnostics of attempt N reach attempt N+1.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../store/db.js';
import { createGraphRun } from '../../../store/graph/graphRuns.js';
import { createPlannerRun, plannerRunById } from '../../../store/graph/plannerRuns.js';
import { parseGraphDocument } from '../parse.js';
import { compileGraphDocument, type CompileDiagnostic, type CompiledGraph, type CommandDefinition, type ProfileTier, type ResolvedRepository } from '../compile.js';
import {
  compileWithRepair,
  MAX_COMPILE_ATTEMPTS,
  type CompileRepairDeps,
  type ParseCompileOutcome,
} from './repair.js';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function harness(): {
  store: ReturnType<typeof openStore>;
  plannerRunId: number;
  graphRunId: number;
  dir: string;
  makeDeps: (overrides?: Partial<CompileRepairDeps>) => CompileRepairDeps;
  context: {
    profiles: Map<string, ProfileTier>;
    commands: Map<string, CommandDefinition>;
    repositories: Map<string, ResolvedRepository>;
  };
} {
  const store = openStore(':memory:');
  const ticketId = Number(
    store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = createGraphRun(store.db, {
    ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: '2026-08-11T00:00:00.000Z',
  });
  const plannerRunId = createPlannerRun(store.db, {
    graphRunId,
    plannerRunNumber: 1,
    kind: 'bootstrap',
  });
  const dir = mkdtempSync(join(tmpdir(), 'karst-repair-'));
  const context: {
    profiles: Map<string, ProfileTier>;
    commands: Map<string, CommandDefinition>;
    repositories: Map<string, ResolvedRepository>;
  } = {
    profiles: new Map<string, ProfileTier>([
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
  };
  const parseAndCompile = (bytes: Uint8Array): ParseCompileOutcome => {
    const parsed = parseGraphDocument(DECODER.decode(bytes));
    if (!parsed.ok) {
      const diagnostics: CompileDiagnostic[] = parsed.diagnostics.map((d) => ({
        code: d.code as CompileDiagnostic['code'],
        where: d.where,
        message: d.message,
        severity: 'error',
      }));
      return { ok: false, diagnostics };
    }
    const compiled = compileGraphDocument(parsed.document, {
      profiles: context.profiles,
      commands: context.commands,
      repositories: context.repositories,
      artifactFileExists: () => true,
      expertSpend: { spentPlannerRuns: 0, permittedReplans: 0, bootstrapUnspent: true },
      projectMaxima: { maxNodeRuns: 200, maxExpertRuns: 10, maxReplans: 5 },
    });
    return compiled;
  };
  const makeDeps = (overrides?: Partial<CompileRepairDeps>): CompileRepairDeps => ({
    db: store.db,
    transaction: <T>(fn: () => T): T => store.db.transaction(fn)(),
    runPlanner: () => undefined,
    parseAndCompile,
    writeDiagnostics: (plannerRunId: number, attempt: number, diagnostics) => {
      writeFileSync(
        join(dir, `diagnostics-${plannerRunId}-${attempt}.json`),
        JSON.stringify(diagnostics),
      );
    },
    ...overrides,
  });
  return { store, plannerRunId, graphRunId, dir, makeDeps, context };
}

/** A minimal valid graph document (one command node reaching END). */
function validGraph(): string {
  return JSON.stringify({
    version: 1,
    title: 'Valid',
    rationaleArtifact: 'task',
    entries: ['v'],
    artifacts: [
      {
        id: 'task',
        path: 'artifacts/plan/task.md',
        producer: '$planner',
        consumers: [],
        mediaType: 'text/markdown',
        maxBytes: 1024,
        required: true,
      },
    ],
    nodes: [
      {
        id: 'v',
        kind: 'command',
        label: 'Verify',
        command: 'test',
        repositories: ['api'],
        outcomes: ['passed', 'failed', 'infrastructure-error'],
        budget: { maxVisits: 1 },
      },
    ],
    edges: [
      { id: 'v-pass', from: 'v', on: 'passed', to: 'END' },
      { id: 'v-fail', from: 'v', on: 'failed', to: 'END' },
    ],
    budgets: { maxNodeRuns: 2, maxExpertRuns: 1, maxReplans: 0 },
  });
}

/** An invalid document: an edge fires an undeclared outcome. */
function invalidGraph(seed: string): string {
  const d = JSON.parse(validGraph()) as Record<string, unknown>;
  d['title'] = seed;
  (d['edges'] as unknown[]).push({ id: `e-${seed}`, from: 'v', on: 'blocked', to: 'END' });
  return JSON.stringify(d);
}

describe('compileWithRepair', () => {
  it('terminates at three attempts with graph-plan-invalid for byte-identical output', () => {
    const { store, plannerRunId, makeDeps } = harness();
    const calls: number[] = [];
    const result = compileWithRepair(
      plannerRunId,
      makeDeps({
        runPlanner: (_id, attempt) => {
          calls.push(attempt);
          return ENCODER.encode(invalidGraph('same'));
        },
      }),
    );
    expect(calls).toEqual([1, 2, 3]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('graph-plan-invalid');
    expect(result.attempts).toBe(MAX_COMPILE_ATTEMPTS);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(plannerRunById(store.db, plannerRunId)!.compile_attempt).toBe(3);
  });

  it('leaves the planner-run and expert-run counters unchanged across all three attempts', () => {
    const { store, plannerRunId, graphRunId, makeDeps } = harness();
    const result = compileWithRepair(
      plannerRunId,
      makeDeps({
        runPlanner: () => ENCODER.encode(invalidGraph('same')),
      }),
    );
    expect(result.ok).toBe(false);
    const plannerRuns = store.db
      .prepare('SELECT COUNT(*) AS n FROM approach_planner_runs')
      .get() as { n: number };
    expect(plannerRuns.n).toBe(1);
    const expertRuns = store.db
      .prepare('SELECT expert_run_count AS n FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { n: number };
    expect(expertRuns.n).toBe(0);
  });

  it('carries the diagnostics of attempt N into attempt N+1', () => {
    const { plannerRunId, dir, makeDeps } = harness();
    const received: Array<{ attempt: number; diagnostics: CompileDiagnostic[] }> = [];
    let call = 0;
    const result = compileWithRepair(
      plannerRunId,
      makeDeps({
        runPlanner: (_id, attempt, diagnostics) => {
          received.push({ attempt, diagnostics });
          call += 1;
          // A DIFFERENT invalid document each attempt; the newest diagnostics
          // must reach the next attempt, and the final result carries the
          // newest (attempt 3's) diagnostics.
          return ENCODER.encode(invalidGraph(`doc-${call}`));
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(received.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(received[0]!.diagnostics).toEqual([]);
    expect(received[1]!.diagnostics.length).toBeGreaterThan(0);
    expect(received[2]!.diagnostics.length).toBeGreaterThan(0);
    // The diagnostics file is written per attempt so the planner reads them.
    expect(readFileSync(join(dir, 'diagnostics-1-1.json'), 'utf8')).toBe(
      JSON.stringify(received[1]!.diagnostics),
    );
  });

  it('succeeds when an attempt produces a valid document', () => {
    const { store, plannerRunId, makeDeps } = harness();
    let call = 0;
    const result = compileWithRepair(
      plannerRunId,
      makeDeps({
        runPlanner: () => {
          call += 1;
          return ENCODER.encode(call === 1 ? invalidGraph('first') : validGraph());
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
    expect(result.compiled.fingerprint).toHaveLength(64);
    expect(plannerRunById(store.db, plannerRunId)!.compile_attempt).toBe(2);
  });

  it('reports planner-no-output without counting a compile rejection', () => {
    const { store, plannerRunId, makeDeps } = harness();
    const result = compileWithRepair(
      plannerRunId,
      makeDeps({
        runPlanner: () => undefined,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('planner-no-output');
    expect(result.attempts).toBe(1);
    expect(plannerRunById(store.db, plannerRunId)!.compile_attempt).toBe(1);
  });
});
