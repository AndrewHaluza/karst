/**
 * Bounded structured graph diagnostics (Slice 6 Task 3).
 *
 * The emitter renders ONE bounded, redacted line per event through the
 * injected `debug` callback — host-agnostic, never importing the logger. The
 * full key set (project, ticket, stage attempt, graph, revision, planner run,
 * node run, generation) is present on every line; the detail tail is capped
 * before it reaches the callback; and the rendered line passes through the
 * SAME redaction pipeline (`sanitizeText`) the diagnostic buffer applies at
 * capture, so a capability, a prompt body, or a secret-shaped value never
 * reaches a line.
 */

import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import {
  emitGraphDiagnostic,
  renderGraphDiagnosticLine,
  resolveGraphDiagnosticIdentity,
  GRAPH_DIAGNOSTIC_CATEGORIES,
  type GraphDiagnosticKeys,
} from './diagnostics.js';

function harness() {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const projectId = Number(
    db.prepare("INSERT INTO projects (slug) VALUES ('acme')").run().lastInsertRowid,
  );
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key, project_id) VALUES ('T-1', ?)").run(projectId).lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 2, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId)
      .lastInsertRowid,
  );
  const debug = vi.fn();
  const deps = { db, debug };
  return { db, debug, deps, projectId, ticketId, graphRunId, revisionId };
}

describe('emitGraphDiagnostic', () => {
  it('emits every closed category with its full key set', () => {
    for (const category of GRAPH_DIAGNOSTIC_CATEGORIES) {
      const { debug, deps, graphRunId, revisionId } = harness();
      const line = emitGraphDiagnostic(deps, {
        category,
        graphRunId,
        revisionId,
        plannerRunId: 11,
        nodeRunId: 7,
        generation: 'gen-9',
        detail: 'something happened',
      });
      expect(line, category).toBeDefined();
      expect(debug, category).toHaveBeenCalledTimes(1);
      const emitted = debug.mock.calls[0]![0] as string;
      expect(emitted.startsWith(`[graph:${category}]`), category).toBe(true);
      expect(emitted, category).toContain('project=acme');
      expect(emitted, category).toContain('ticket=T-1');
      expect(emitted, category).toContain('attempt=2');
      expect(emitted, category).toContain(`graph=${graphRunId}`);
      expect(emitted, category).toContain(`revision=${revisionId}`);
      expect(emitted, category).toContain('planner=11');
      expect(emitted, category).toContain('node=7');
      expect(emitted, category).toContain('gen=gen-9');
      expect(emitted, category).not.toContain('\n');
    }
  });

  it('redacts a capability, a prompt body, and a secret-shaped value from every emitted line', () => {
    const { debug, deps, graphRunId } = harness();
    // 64+ chars mixing upper/lower/digit — the completion-capability shape the
    // `longCredential` rule strips.
    const capability = '8f3aB9cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1yZ2aB3cD4eF5gH6iJ7kL8mN9oP0q';
    const secret = 'ghp_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const promptBody = `You are the graph node. Implement the feature end to end across every repository: ${'context paragraph '.repeat(60)}`;
    const line = emitGraphDiagnostic(deps, {
      category: 'claim',
      graphRunId,
      detail: `${capability} ${secret} ${promptBody}`,
    });
    expect(line).toBeDefined();
    expect(line!).not.toContain(capability);
    expect(line!).not.toContain(secret);
    expect(line!).not.toContain(promptBody);
    expect(line!).toContain('[REDACTED:');
  });

  it('bounds the line under an adversarially long agent reason', () => {
    const { debug, deps, graphRunId } = harness();
    const reason = 'agent said '.repeat(5000);
    const line = emitGraphDiagnostic(deps, { category: 'block', graphRunId, detail: reason });
    expect(line).toBeDefined();
    expect(line!.length).toBeGreaterThan(0);
    expect(line!.length).toBeLessThan(1000);
    expect(line!).not.toContain(reason);
  });

  it('collapses multi-line and control-char detail into one bounded line', () => {
    const { deps, graphRunId } = harness();
    const line = emitGraphDiagnostic(deps, {
      category: 'recovery',
      graphRunId,
      detail: 'line one\nline two\t\ttabbed\u0001ctrl',
    });
    expect(line).toBeDefined();
    expect(line!).not.toContain('\n');
    expect(line!).toContain('line one line two tabbed ctrl');
  });

  it('reads NOTHING when no debug callback is bound', () => {
    const { deps, graphRunId } = harness();
    // Debug off is the default, and the sweep emits one of these per transition
    // inside its BEGIN IMMEDIATE — an identity JOIN per event would lengthen the
    // write-lock hold for a line nobody receives. Off must cost one branch.
    let reads = 0;
    const counting = {
      ...deps,
      debug: undefined,
      db: {
        prepare: (sql: string) => {
          reads += 1;
          return deps.db.prepare(sql);
        },
      } as unknown as typeof deps.db,
    };
    const line = emitGraphDiagnostic(counting, { category: 'claim', graphRunId });
    expect(line).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('emits nothing for an unknown run', () => {
    const { debug, deps } = harness();
    const line = emitGraphDiagnostic(deps, { category: 'claim', graphRunId: 999 });
    expect(line).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('resolveGraphDiagnosticIdentity', () => {
  it('reads the run identity — project slug, ticket key, stage attempt — from the store', () => {
    const { db, graphRunId } = harness();
    expect(resolveGraphDiagnosticIdentity(db, graphRunId)).toEqual({
      project: 'acme',
      ticket: 'T-1',
      stageAttempt: 2,
    });
  });
});

describe('renderGraphDiagnosticLine', () => {
  const fullKeys: GraphDiagnosticKeys = {
    project: 'acme',
    ticket: 'T-1',
    stageAttempt: 2,
    graphRunId: 1,
    revisionId: 3,
    plannerRunId: 5,
    nodeRunId: 9,
    generation: 'g',
  };

  it('renders every closed category as the full keyed line shape', () => {
    for (const category of GRAPH_DIAGNOSTIC_CATEGORIES) {
      const line = renderGraphDiagnosticLine(fullKeys, category, 'detail');
      expect(line).toBe(
        `[graph:${category}] project=acme ticket=T-1 attempt=2 graph=1 revision=3 planner=5 node=9 gen=g detail`,
      );
    }
  });

  it('renders null placeholders for every absent key', () => {
    const keys: GraphDiagnosticKeys = {
      project: null,
      ticket: null,
      stageAttempt: null,
      graphRunId: 3,
      revisionId: null,
      plannerRunId: null,
      nodeRunId: null,
      generation: null,
    };
    const line = renderGraphDiagnosticLine(keys, 'defer');
    expect(line).toBe(
      '[graph:defer] project=null ticket=null attempt=null graph=3 revision=null planner=null node=null gen=null',
    );
  });
});
