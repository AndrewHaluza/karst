import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { composeVisitMailbox, mayInjectIntoVisit } from './visitMailbox.js';

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
  return { db, graphRunId, revisionId };
}

describe('composeVisitMailbox', () => {
  it('is empty when nothing is pending', () => {
    expect(composeVisitMailbox({ unreadMail: 0, unreadNotes: 0, noteTitles: [] })).toBe('');
  });

  it('names the singular unread message count without a command hint', () => {
    const text = composeVisitMailbox({ unreadMail: 1, unreadNotes: 0, noteTitles: [] });
    expect(text).toContain('1 unread message.');
    expect(text).not.toContain('1 unread messages');
    expect(text.startsWith('## Ticket mailbox\n')).toBe(true);
    expect(text).not.toContain('karst inbox');
    expect(text).not.toContain('karst notes post');
    expect(text).not.toContain('`notes`');
  });

  it('renders plural counts and the note titles, with no command hints', () => {
    const text = composeVisitMailbox({ unreadMail: 2, unreadNotes: 1, noteTitles: ['T1'] });
    expect(text).toContain('2 unread messages.');
    expect(text).toContain('1 unread project note match this ticket.');
    expect(text).toContain('- T1');
    expect(text).not.toContain('karst inbox');
    expect(text).not.toContain('karst notes post');
    expect(text).not.toContain('`notes`');
  });

  it('renders several note titles without a command hint', () => {
    const text = composeVisitMailbox({ unreadMail: 0, unreadNotes: 2, noteTitles: ['T1', 'T2'] });
    expect(text).toContain('2 unread project notes match this ticket.');
    expect(text).toContain('- T1');
    expect(text).toContain('- T2');
    expect(text).not.toContain('karst inbox');
    expect(text).not.toContain('karst notes post');
    expect(text).not.toContain('`notes`');
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
