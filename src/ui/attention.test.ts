import { describe, it, expect } from 'vitest';
import { attentionItems } from './attention.js';
import type { TicketWithStages } from '../store/tickets.js';
import type { StageKey, StageStatus } from '../model/types.js';

const stage = (key: StageKey, status: StageStatus): TicketWithStages['stages'][number] => ({
  ticketId: 1,
  stageKey: key,
  status,
  attempt: 0,
  verdict: null,
  artifactPath: null,
  startedAt: null,
  endedAt: null,
});

function ticket(over: Partial<TicketWithStages> = {}): TicketWithStages {
  return {
    id: 1,
    key: 'PROJ-1',
    title: 'a thing',
    source: 'manual',
    stageCurrent: 'impl',
    agentState: 'none',
    sessionId: null,
    description: null,
    brief: null,
    sourceRef: null,
    sourceFetchedAt: null,
    approach: null,
    agent: null,
    selectedRepos: [],
    archivedAt: null,
    updatedAt: null,
    model: null,
    agentProvider: null,
    sessionProvider: null,
    type: null,
    projectId: null,
    parentTicketId: null,
    stages: [stage('impl', 'running')],
    ...over,
  };
}

describe('attentionItems', () => {
  it('is empty when nothing needs the user', () => {
    expect(attentionItems([ticket()])).toEqual([]);
  });

  it('reports a waiting agent as input', () => {
    const items = attentionItems([ticket({ agentState: 'waiting' })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      ticketId: 1,
      key: 'PROJ-1',
      title: 'a thing',
      stage: 'impl',
      kind: 'input',
      reason: 'agent asked a question',
    });
  });

  it('reports a pending confirm stage as input, naming the stage', () => {
    const items = attentionItems([
      ticket({ stageCurrent: 'ship', stages: [stage('ship', 'pending')] }),
    ]);
    expect(items[0]).toMatchObject({
      kind: 'input',
      reason: 'awaiting confirmation · ship',
    });
  });

  it('reports a failed stage as failed, naming the stage', () => {
    const items = attentionItems([
      ticket({ stageCurrent: 'uat', stages: [stage('uat', 'failed')] }),
    ]);
    expect(items[0]).toMatchObject({ kind: 'failed', reason: 'uat failed' });
  });

  it('falls back to #id and an empty title when the ticket has neither', () => {
    const items = attentionItems([ticket({ key: null, title: null, agentState: 'waiting' })]);
    expect(items[0]).toMatchObject({ key: '#1', title: '' });
  });

  it('sorts failed before input, then longest-waiting first', () => {
    const items = attentionItems([
      ticket({ id: 1, key: 'A-1', agentState: 'waiting', updatedAt: '2026-07-30T00:00:00Z' }),
      ticket({ id: 2, key: 'A-2', agentState: 'waiting', updatedAt: '2026-07-28T00:00:00Z' }),
      ticket({
        id: 3,
        key: 'A-3',
        stageCurrent: 'uat',
        stages: [stage('uat', 'failed')],
        updatedAt: '2026-07-31T00:00:00Z',
      }),
    ]);
    expect(items.map((i) => i.key)).toEqual(['A-3', 'A-2', 'A-1']);
  });

  it('sorts an unknown updatedAt last within its kind, not first', () => {
    const items = attentionItems([
      ticket({ id: 1, key: 'A-1', agentState: 'waiting', updatedAt: null }),
      ticket({ id: 2, key: 'A-2', agentState: 'waiting', updatedAt: '2026-07-28T00:00:00Z' }),
    ]);
    expect(items.map((i) => i.key)).toEqual(['A-2', 'A-1']);
  });
});
