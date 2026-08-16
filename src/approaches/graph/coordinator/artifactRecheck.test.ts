/**
 * Artifact-fault re-check tests.
 *
 * The two artifact faults are corrected OUT OF BAND, so the only honest
 * evidence that the correction happened is re-asking the question that
 * faulted: `validateRequiredOutputs` against the same declared output paths
 * and the same artifact root. These pin that the re-check fails closed (still
 * missing, still unsafe, unknown root) and passes only on a real correction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../../../store/db.js';
import {
  ARTIFACT_FAULT_STATUSES,
  artifactFaultNodeRows,
  recheckArtifactFaults,
} from './artifactRecheck.js';

const NOW = '2026-08-12T00:00:00.000Z';

const GRAPH = JSON.stringify({
  version: 1,
  title: 't',
  rationaleArtifact: 'r',
  entries: ['n'],
  artifacts: [
    {
      id: 'r',
      path: 'r.md',
      producer: 'n',
      consumers: [],
      mediaType: 'text/markdown',
      maxBytes: 1024,
      required: true,
    },
  ],
  nodes: [
    {
      id: 'n',
      kind: 'agent',
      label: 'n',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: ['r'],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked'],
      budget: { maxVisits: 2 },
    },
  ],
  edges: [{ id: 'e-n-end', from: 'n', on: 'complete', to: 'END' }],
  budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 2 },
});

describe('recheckArtifactFaults', () => {
  let store: Store;
  let root: string;
  let graphRunId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    root = mkdtempSync(join(tmpdir(), 'karst-recheck-'));
    const ticketId = Number(
      store.db.prepare("INSERT INTO tickets (key) VALUES ('AR-1')").run().lastInsertRowid,
    );
    graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', ?)`,
        )
        .run(ticketId, NOW).lastInsertRowid,
    );
    const revisionId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, 1, ?, 'fp', 'active', ?)`,
        )
        .run(graphRunId, GRAPH, NOW).lastInsertRowid,
    );
    for (const [id, status] of [[7, 'output-artifact-missing'], [8, 'completed']] as const) {
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, ?, 'n', 'agent', ?, ?)`,
        )
        .run(id, graphRunId, revisionId, id, status);
    }
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('selects only the artifact-faulted node runs', () => {
    expect(artifactFaultNodeRows(store.db, graphRunId).map((r) => r.id)).toEqual([7]);
    expect([...ARTIFACT_FAULT_STATUSES]).toEqual(['output-artifact-missing', 'artifact-unsafe']);
  });

  it('fails closed while the required output is still missing', () => {
    const outcome = recheckArtifactFaults(store.db, graphRunId, () => root);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('artifact "r" still output-artifact-missing');
  });

  it('fails closed when the artifact root is unknown — an unprovable correction', () => {
    writeFileSync(join(root, 'r.md'), '# corrected');
    const outcome = recheckArtifactFaults(store.db, graphRunId, () => undefined);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('artifact root is unknown');
    expect(recheckArtifactFaults(store.db, graphRunId).ok).toBe(false);
  });

  it('fails closed while the bytes are unsafe for the declared media type', () => {
    store.db.prepare("UPDATE approach_node_runs SET status = 'artifact-unsafe' WHERE id = 7").run();
    writeFileSync(join(root, 'r.md'), Buffer.from([0x23, 0x00, 0x61]));
    const outcome = recheckArtifactFaults(store.db, graphRunId, () => root);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('still artifact-unsafe');
  });

  it('passes once the artifact is really corrected', () => {
    writeFileSync(join(root, 'r.md'), '# corrected');
    expect(recheckArtifactFaults(store.db, graphRunId, () => root)).toEqual({
      ok: true,
      rechecked: [7],
    });
  });

  it('is trivially ok for a graph run with no artifact fault', () => {
    store.db.prepare("UPDATE approach_node_runs SET status = 'blocked' WHERE id = 7").run();
    expect(recheckArtifactFaults(store.db, graphRunId, () => undefined)).toEqual({
      ok: true,
      rechecked: [],
    });
  });
});
