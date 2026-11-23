import { describe, it, expect } from 'vitest';
import {
  attentionItems,
  attentionSummary,
  AttentionManager,
  type AttentionItem,
  type AttentionHost,
} from './attention.js';
import type { TicketWithStages } from '../store/tickets.js';
import type { StageKey, StageStatus } from '../model/types.js';
import { facetCounts } from './sidebar/facets.js';

const stage = (key: StageKey, status: StageStatus): TicketWithStages['stages'][number] => ({
  ticketId: 1,
  stageKey: key,
  status,
  attempt: 0,
  verdict: null,
  artifactPath: null,
  startedAt: null,
  endedAt: null,
  blockedKind: null,
  blockedReason: null,
  blockedAt: null,
});

function ticket(over: Partial<TicketWithStages> = {}): TicketWithStages {
  return {
    id: 1,
    key: 'PROJ-1',
    title: 'a thing',
    source: 'manual',
    pausedAt: null,
    stageCurrent: 'impl',
    agentState: 'none',
    sessionId: null,
    description: null,
    brief: null,
    intent: null,
    codePointers: null,
    sourceRef: null,
    sourceRefInternal: null,
    sourceFetchedAt: null,
    approach: null,
    agent: null,
    selectedRepos: [],
    baseRefs: {},
    baseShas: {},
    archivedAt: null,
    updatedAt: null,
    model: null,
    effort: null,
    agentProvider: null,
    agentPreset: null,
    sessionProvider: null,
    type: null,
    projectId: null,
    parentTicketId: null,
    subtaskParentId: null,
    blocksParent: false,
    autostartPending: false,
    autostartStarting: false,
    autostartClaimedAt: null,
    priority: null,
    priorityOverride: null,
    serversOnDone: null,
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

  it('reports a not-started agent as input, naming the launch-delivery reason', () => {
    const items = attentionItems([ticket({ agentState: 'not-started' })]);
    expect(items[0]).toMatchObject({
      kind: 'input',
      reason: 'session did not start',
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

  it('reports a failed stage as failed, naming the stage in title case (SB-18)', () => {
    const items = attentionItems([
      ticket({ stageCurrent: 'uat', stages: [stage('uat', 'failed')] }),
    ]);
    expect(items[0]).toMatchObject({ kind: 'failed', reason: 'UAT failed' });
    const review = attentionItems([
      ticket({ stageCurrent: 'review', stages: [stage('review', 'failed')] }),
    ]);
    expect(review[0]!.reason).toBe('Review failed');
  });

  it('falls back to T<id> and an empty title when the ticket has neither', () => {
    const items = attentionItems([ticket({ key: null, title: null, agentState: 'waiting' })]);
    expect(items[0]).toMatchObject({ key: 'T1', title: '' });
  });

  it('sorts failed before input, then by updated_at as a recency tiebreaker', () => {
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

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  ticketId: 1,
  key: 'A-1',
  title: 'a thing',
  stage: 'impl',
  kind: 'input',
  reason: 'agent asked a question',
  ...over,
});

describe('attentionSummary', () => {
  it('returns null for an empty set — nothing is shown when nothing is wrong', () => {
    expect(attentionSummary([])).toBeNull();
  });

  it('uses singular copy for one ticket', () => {
    const s = attentionSummary([item()]);
    expect(s?.text).toBe('$(bell) 1 needs you');
    expect(s?.badgeTooltip).toBe('1 needs your input');
    expect(s?.count).toBe(1);
  });

  it('uses plural copy for several tickets', () => {
    const s = attentionSummary([item(), item({ ticketId: 2, key: 'A-2' })]);
    expect(s?.text).toBe('$(bell) 2 need you');
    expect(s?.badgeTooltip).toBe('2 need your input');
  });

  it('splits the badge tooltip and the tooltip head by kind (RD-2)', () => {
    const items = (input: number, failed: number): AttentionItem[] => [
      ...Array.from({ length: input }, (_, i) => item({ ticketId: i + 1, key: `I-${i + 1}` })),
      ...Array.from({ length: failed }, (_, i) => item({ ticketId: 100 + i, key: `F-${i + 1}`, kind: 'failed' })),
    ];
    expect(attentionSummary(items(4, 2))?.badgeTooltip).toBe('4 need your input, 2 failed');
    expect(attentionSummary(items(0, 2))?.badgeTooltip).toBe('2 failed');
    expect(attentionSummary(items(1, 1))?.badgeTooltip).toBe('1 needs your input, 1 failed');
    expect(attentionSummary(items(1, 0))?.badgeTooltip).toBe('1 needs your input');
    // The tooltip head is the same split line, then a blank line, then the tickets.
    expect(attentionSummary(items(4, 2))?.tooltip.startsWith('4 need your input, 2 failed\n\n')).toBe(true);
  });

  it('the header parts sum to the attention set for the same tickets (RD-2)', () => {
    const tickets = [
      ticket({ id: 1, agentState: 'waiting' }),
      ticket({ id: 2, agentState: 'not-started' }),
      ticket({ id: 3, stageCurrent: 'impl', stages: [stage('impl', 'running')] }),
      ticket({ id: 4, stageCurrent: 'uat', stages: [stage('uat', 'failed')] }),
      ticket({ id: 5, stageCurrent: 'uat', stages: [stage('uat', 'running')] }),
    ];
    const counts = facetCounts(tickets);
    expect(counts.input + counts.failed).toBe(attentionItems(tickets).length);
    expect(counts.input).toBe(2);
    expect(counts.failed).toBe(1);
  });

  it('lists one key · reason line per ticket in the tooltip, after the split head', () => {
    const s = attentionSummary([
      item({ key: 'A-3', kind: 'failed', reason: 'uat failed' }),
      item({ ticketId: 2, key: 'A-1' }),
    ]);
    expect(s?.tooltip).toBe('1 needs your input, 1 failed\n\nA-3 · uat failed\n\nA-1 · agent asked a question');
  });

  it('warns only when something is actually blocked', () => {
    expect(attentionSummary([item()])?.warning).toBe(false);
    expect(attentionSummary([item({ kind: 'failed' })])?.warning).toBe(true);
  });

  it('caps the tooltip at 10 lines and says how many it dropped', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      item({ ticketId: i + 1, key: `A-${i + 1}` }),
    );
    const [head, ...lines] = attentionSummary(many)!.tooltip.split('\n\n');
    expect(head).toBe('13 need your input');
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe('…and 3 more');
    expect(attentionSummary(many)?.count).toBe(13);
  });
});

function fakeHost(): AttentionHost & {
  status: Array<[string, string, boolean]>;
  badges: Array<[number, string]>;
  hidden: number;
  cleared: number;
} {
  const h = {
    status: [] as Array<[string, string, boolean]>,
    badges: [] as Array<[number, string]>,
    hidden: 0,
    cleared: 0,
    setStatus: (text: string, tooltip: string, warning: boolean) => {
      h.status.push([text, tooltip, warning]);
    },
    hideStatus: () => {
      h.hidden += 1;
    },
    setBadge: (value: number, tooltip: string) => {
      h.badges.push([value, tooltip]);
    },
    clearBadge: () => {
      h.cleared += 1;
    },
  };
  return h;
}

describe('AttentionManager', () => {
  it('hides both surfaces on an empty set, and never badges a zero', () => {
    const host = fakeHost();
    new AttentionManager(host).render([]);
    expect(host.hidden).toBe(1);
    expect(host.cleared).toBe(1);
    expect(host.status).toEqual([]);
    expect(host.badges).toEqual([]);
  });

  it('paints status and badge from the same summary', () => {
    const host = fakeHost();
    new AttentionManager(host).render([item(), item({ ticketId: 2, key: 'A-2' })]);
    expect(host.status).toEqual([
      [
        '$(bell) 2 need you',
        '2 need your input\n\nA-1 · agent asked a question\n\nA-2 · agent asked a question',
        false,
      ],
    ]);
    expect(host.badges).toEqual([[2, '2 need your input']]);
  });

  it('flags the status warning when a ticket is blocked', () => {
    const host = fakeHost();
    new AttentionManager(host).render([item({ kind: 'failed', reason: 'uat failed' })]);
    expect(host.status[0]![2]).toBe(true);
  });
});
