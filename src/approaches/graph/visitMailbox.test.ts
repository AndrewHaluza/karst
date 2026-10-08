import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { parseGraphDocument } from './parse.js';
import { composeVisitMailbox, isCompletingVisit, mayInjectIntoVisit } from './visitMailbox.js';

const NOW = '2026-08-12T00:00:00.000Z';

function docJson(): string {
  const node = (id: string) => ({
    id, kind: 'agent', label: id, profile: 'worker', instructionsArtifact: 'instructions', inputs: [], outputs: [],
    resources: { reads: [], writes: [] }, outcomes: ['complete'], budget: { maxVisits: 3 },
  });
  return JSON.stringify({
    version: 1, title: 't', rationaleArtifact: 'rationale', entries: ['a'],
    artifacts: [
      { id: 'rationale', path: 'artifacts/rationale.md', producer: '$planner', consumers: ['a'], mediaType: 'text/markdown', maxBytes: 10240, required: true },
      { id: 'instructions', path: 'artifacts/instructions.md', producer: '$planner', consumers: ['a', 'b'], mediaType: 'text/markdown', maxBytes: 10240, required: true },
    ],
    nodes: [node('a'), node('b')],
    edges: [
      { id: 'e0', from: 'a', on: 'entry', to: 'a' },
      { id: 'e1', from: 'a', on: 'complete', to: 'b' },
      { id: 'e2', from: 'b', on: 'complete', to: 'END' },
    ],
    budgets: { maxNodeRuns: 40, maxExpertRuns: 5, maxReplans: 2 },
  });
}

function setup(over: { runStatus?: string; revStatus?: string } = {}) {
  const { db } = openStore(':memory:');
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db.prepare(
      `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (?, 'impl', 0, 'x', ?, ?)`,
    ).run(ticketId, over.runStatus ?? 'running', NOW).lastInsertRowid,
  );
  const revisionId = Number(
    db.prepare(
      `INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (?, 1, ?, 'fp', ?, ?)`,
    ).run(graphRunId, docJson(), over.revStatus ?? 'active', NOW).lastInsertRowid,
  );
  const run = (nodeId: string, status: string): number =>
    Number(
      db.prepare(
        `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (?, ?, ?, 'agent', 1, ?)`,
      ).run(graphRunId, revisionId, nodeId, status).lastInsertRowid,
    );
  const parsed = parseGraphDocument(docJson());
  if (!parsed.ok) throw new Error('fixture');
  return { db, graphRunId, revisionId, run, document: parsed.document };
}

describe('composeVisitMailbox', () => {
  it('is empty when nothing is pending and the visit is not completing', () => {
    expect(composeVisitMailbox({ unreadMail: 0, unreadNotes: 0, noteTitles: [], completing: false })).toBe('');
  });
  it('points at inbox and notes with titles only', () => {
    const text = composeVisitMailbox({ unreadMail: 2, unreadNotes: 1, noteTitles: ['T1'], completing: false });
    expect(text).toContain('2 unread messages — run `karst inbox`');
    expect(text).toContain('1 unread project note match this ticket — run `karst notes`');
    expect(text).toContain('- T1');
    expect(text).not.toContain('karst notes post');
  });
  it('asks for a note only when completing', () => {
    const text = composeVisitMailbox({ unreadMail: 0, unreadNotes: 0, noteTitles: [], completing: true });
    expect(text).toContain('karst notes post');
  });
});

describe('mayInjectIntoVisit', () => {
  it('allows a running run on its active revision', () => {
    const s = setup();
    expect(mayInjectIntoVisit(s.db, { graphRunId: s.graphRunId, revisionId: s.revisionId, nodeRunId: 1, nodeId: 'a' })).toBe(true);
  });
  it('refuses mid-replan (draining run)', () => {
    const s = setup({ runStatus: 'draining', revStatus: 'draining' });
    expect(mayInjectIntoVisit(s.db, { graphRunId: s.graphRunId, revisionId: s.revisionId, nodeRunId: 1, nodeId: 'a' })).toBe(false);
  });
  it('refuses a stranded (superseded) revision', () => {
    const s = setup({ revStatus: 'superseded' });
    expect(mayInjectIntoVisit(s.db, { graphRunId: s.graphRunId, revisionId: s.revisionId, nodeRunId: 1, nodeId: 'a' })).toBe(false);
  });
});

describe('isCompletingVisit', () => {
  it('is true only for the sole active visit whose edges all end the graph', () => {
    const s = setup();
    const a = s.run('a', 'launching');
    const b = s.run('b', 'launching');
    const id = (nodeRunId: number, nodeId: string) => ({ graphRunId: s.graphRunId, revisionId: s.revisionId, nodeRunId, nodeId });
    expect(isCompletingVisit(s.db, id(a, 'a'), s.document)).toBe(false); // a → b, not END
    expect(isCompletingVisit(s.db, id(b, 'b'), s.document)).toBe(false); // a still active
    s.db.prepare("UPDATE approach_node_runs SET status = 'completed' WHERE id = ?").run(a);
    expect(isCompletingVisit(s.db, id(b, 'b'), s.document)).toBe(true);
  });
});
