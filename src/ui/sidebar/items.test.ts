import { describe, it, expect } from 'vitest';
import {
  buildTicketNodes,
  filterTickets,
  isDoneTicket,
  isAwaitingReview,
  completedAt,
  nestSubtasks,
  visibleTicketRows,
  MAX_SUBTASK_INDENT,
} from './items.js';
import type { TicketNode, SidebarPr } from './items.js';
import type { TicketWithStages } from '../../store/tickets.js';
import { MAX_SUBTASK_DEPTH } from '../../workflow/stages/subtask.js';

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
    sourceRef: null,
    sourceRefInternal: null,
    sourceFetchedAt: null,
    approach: null,
    agent: null,
    selectedRepos: [],
    baseRefs: {},
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
    stages: [
      { ticketId: 1, stageKey: 'scope', status: 'passed', attempt: 0, verdict: 'passed', artifactPath: null, startedAt: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null },
      { ticketId: 1, stageKey: 'impl', status: 'running', attempt: 0, verdict: null, artifactPath: null, startedAt: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null },
    ],
    ...over,
  };
}

describe('buildTicketNodes', () => {
  it('maps each ticket to a collapsible ticket node with label from key + title', () => {
    const nodes = buildTicketNodes([ticket()]);
    expect(nodes).toHaveLength(1);
    const n = nodes[0]!;
    expect(n.kind).toBe('ticket');
    expect(n.ticketId).toBe(1);
    expect(n.label).toContain('PROJ-1');
    expect(n.label).toContain('a thing');
    expect(n.collapsible).toBe(true);
  });

  it('carries no parentKey for an ordinary ticket', () => {
    const [node] = buildTicketNodes([ticket({ parentTicketId: null })]);
    expect(node!.parentKey).toBeNull();
  });

  it('resolves parentKey from the supplied lookup map when parentTicketId is set', () => {
    const parentKeys = new Map([[1, 'PROJ-1']]);
    const [node] = buildTicketNodes(
      [ticket({ id: 2, parentTicketId: 1 })],
      undefined,
      undefined,
      parentKeys,
    );
    expect(node!.parentKey).toBe('PROJ-1');
  });

  it('falls back to null when parentTicketId points outside the supplied map', () => {
    const [node] = buildTicketNodes(
      [ticket({ id: 2, parentTicketId: 999 })],
      undefined,
      undefined,
      new Map(),
    );
    expect(node!.parentKey).toBeNull();
  });

  it('labels a follow-up with the plain title, never a Follow-up: prefix', () => {
    const parentKeys = new Map([[1, 'PROJ-1']]);
    const [node] = buildTicketNodes(
      [ticket({ id: 2, key: 'PROJ-1-fu1', title: 'Ship the thing', parentTicketId: 1 })],
      undefined,
      undefined,
      parentKeys,
    );
    expect(node!.label).toBe('PROJ-1-fu1 — Ship the thing');
    expect(node!.label.startsWith('Follow-up:')).toBe(false);
    expect(node!.parentKey).toBe('PROJ-1');
  });

  it('carries the current stage as the node description (visible when folded)', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!;
    expect(n.description).toContain('impl');
  });

  it('shows (none) in the description when no current stage', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null })])[0]!;
    expect(n.description).toContain('none');
  });

  it('carries the human stage badge every row renders (mock parity)', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!;
    expect(n.stageLabel).toBe('Implementing');
  });

  it('falls back to a defined badge when the ticket has no stage', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(n.stageLabel).toBe('Not started');
    expect(n.glyph).toBe('gray');
  });

  it('carries the stage color class the chip renders, matching the dashboard rail', () => {
    expect(buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!.stageClass).toBe('stg-impl');
    expect(buildTicketNodes([ticket({ stageCurrent: 'uat' })])[0]!.stageClass).toBe('stg-uat');
  });

  it('a chipped stage key is the key itself (uppercased in the view), and a stageless ticket falls back', () => {
    expect(buildTicketNodes([ticket({ stageCurrent: 'review' })])[0]!.stageChip).toBe('review');
    expect(buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!.stageClass).toBe('stg-unknown');
    expect(buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!.stageChip).toBe('none');
  });

  it('glyph reflects current stage status + agent state (running impl => blue)', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl', agentState: 'none' })])[0]!;
    expect(n.glyph).toBe('blue');
  });

  it('waiting agent wins => amber regardless of stage', () => {
    const n = buildTicketNodes([
      ticket({ stageCurrent: 'scope', agentState: 'waiting' }),
    ])[0]!;
    expect(n.glyph).toBe('amber');
  });

  it('failed current stage => red; passed => green; unknown current => gray', () => {
    const failed = buildTicketNodes([
      ticket({ stageCurrent: 'scope', agentState: 'none', stages: [
        { ticketId: 1, stageKey: 'scope', status: 'failed', attempt: 0, verdict: 'failed', artifactPath: null, startedAt: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null },
      ] }),
    ])[0]!;
    expect(failed.glyph).toBe('red');

    const passed = buildTicketNodes([
      ticket({ stageCurrent: 'scope', agentState: 'none', stages: [
        { ticketId: 1, stageKey: 'scope', status: 'passed', attempt: 0, verdict: 'passed', artifactPath: null, startedAt: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null },
      ] }),
    ])[0]!;
    expect(passed.glyph).toBe('green');

    const unknown = buildTicketNodes([
      ticket({ stageCurrent: null, agentState: 'none' }),
    ])[0]!;
    expect(unknown.glyph).toBe('gray');
  });

  it('sessionAction reads Continue for a captured interactive session, Start otherwise', () => {
    // Interrupted impl/fix with a captured id → the button continues in place.
    expect(
      buildTicketNodes([
        ticket({ sessionId: 'sid', sessionProvider: 'claude', stageCurrent: 'impl' }),
      ], undefined, 'claude')[0]!.sessionAction,
    ).toEqual({ kind: 'continue', label: 'Continue', detail: 'resume impl' });
    // Captured under a different core → resuming it would die, so re-seed.
    expect(
      buildTicketNodes([
        ticket({ sessionId: 'sid', sessionProvider: 'codex', stageCurrent: 'impl' }),
      ], undefined, 'claude')[0]!.sessionAction,
    ).toEqual({ kind: 'start', label: 'Start', detail: 're-seed from context' });
    // Drafted, never run (no id) → the button starts a fresh session.
    expect(
      buildTicketNodes([ticket({ sessionId: null, stageCurrent: 'scope' })])[0]!.sessionAction,
    ).toEqual({ kind: 'start', label: 'Start', detail: 'fresh session' });
  });

  it('lastActiveAt is the current stage endedAt, else startedAt, else null', () => {
    const ended = buildTicketNodes([
      ticket({
        stageCurrent: 'impl',
        stages: [
          { ticketId: 1, stageKey: 'impl', status: 'passed', attempt: 0, verdict: 'passed', artifactPath: null, startedAt: '2026-07-22T10:00:00Z', endedAt: '2026-07-22T10:05:00Z', blockedKind: null, blockedReason: null, blockedAt: null },
        ],
      }),
    ])[0]!;
    expect(ended.lastActiveAt).toBe('2026-07-22T10:05:00Z');

    const started = buildTicketNodes([
      ticket({
        stageCurrent: 'impl',
        stages: [
          { ticketId: 1, stageKey: 'impl', status: 'running', attempt: 0, verdict: null, artifactPath: null, startedAt: '2026-07-22T10:00:00Z', endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null },
        ],
      }),
    ])[0]!;
    expect(started.lastActiveAt).toBe('2026-07-22T10:00:00Z');

    const none = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(none.lastActiveAt).toBeNull();
  });

  it('passes the ticket model through', () => {
    const n = buildTicketNodes([ticket({ model: 'claude-opus-4-8' })])[0]!;
    expect(n.model).toBe('claude-opus-4-8');
  });

  it('blocker carries the failure reason + attempt when the current stage failed', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 2, verdict: '2 tests red', artifactPath: null, startedAt: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.blocker).toEqual({ reason: '2 tests red', attempt: 2 });
  });

  it('blocker reason is null (line still shows the attempt) when a failed stage has no verdict', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 3, verdict: null, artifactPath: null, startedAt: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.blocker).toEqual({ reason: null, attempt: 3 });
  });

  it('blocker is null for a non-failed stage — status is the row glyph, never duplicated here', () => {
    // shared default: impl running.
    expect(buildTicketNodes([ticket()])[0]!.blocker).toBeNull();
    // needs-you / awaiting / not-started are all just the glyph color too.
    expect(buildTicketNodes([ticket({ agentState: 'waiting' })])[0]!.blocker).toBeNull();
    expect(buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!.blocker).toBeNull();
  });
});

describe('filterTickets', () => {
  const tickets = [
    ticket({ id: 1, key: 'PROJ-1', title: 'add login' }),
    ticket({ id: 2, key: 'PROJ-2', title: 'fix logout' }),
  ];

  it('empty query returns all', () => {
    expect(filterTickets(tickets, '')).toHaveLength(2);
    expect(filterTickets(tickets, '  ')).toHaveLength(2);
  });

  it('matches on key or title, case-insensitive', () => {
    expect(filterTickets(tickets, 'proj-2').map((t) => t.id)).toEqual([2]);
    expect(filterTickets(tickets, 'LOGIN').map((t) => t.id)).toEqual([1]);
    expect(filterTickets(tickets, 'log').map((t) => t.id)).toEqual([1, 2]);
  });
});

describe('isDoneTicket', () => {
  it('is true when the ticket sits at the terminal done stage', () => {
    expect(isDoneTicket(ticket({ stageCurrent: 'done' }))).toBe(true);
  });

  it('is false for every other stage', () => {
    expect(isDoneTicket(ticket({ stageCurrent: 'impl' }))).toBe(false);
    expect(isDoneTicket(ticket({ stageCurrent: 'ship' }))).toBe(false);
    expect(isDoneTicket(ticket({ stageCurrent: null }))).toBe(false);
  });
});

describe('isAwaitingReview', () => {
  const pr = (number: number | null, status: string | null = 'open'): SidebarPr => ({
    repo: 'backend',
    number,
    url: number !== null ? `https://github.com/x/pull/${number}` : null,
    status,
  });

  it('is false when the open PR has a merge conflict (stays actionable in Current)', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1)], true)).toBe(false);
  });

  it('is true when the ticket is at ship with at least one open PR', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1)], false)).toBe(true);
  });

  it('is true with multiple open PRs', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1), pr(2)], false)).toBe(true);
  });

  it('is false when at ship but all PRs have number === null', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(null)], false)).toBe(false);
  });

  it('is false when at ship with an empty PR list', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [], false)).toBe(false);
  });

  it('is false for non-ship stages even with open PRs', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'impl' }), [pr(1)], false)).toBe(false);
    expect(isAwaitingReview(ticket({ stageCurrent: 'review' }), [pr(1)], false)).toBe(false);
    expect(isAwaitingReview(ticket({ stageCurrent: 'uat' }), [pr(1)], false)).toBe(false);
    expect(isAwaitingReview(ticket({ stageCurrent: 'done' }), [pr(1)], false)).toBe(false);
  });

  it('is false when there is no current stage at all', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: null, stages: [] }), [pr(1)], false)).toBe(false);
  });

  it('is false when the only PR is merged — a landed PR awaits no review', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1, 'merged')], false)).toBe(false);
  });

  it('is false when the only PR is closed — a closed PR awaits no review', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1, 'closed')], false)).toBe(false);
  });

  it('is true when one open PR remains beside a merged sibling', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1, 'merged'), pr(2)], false)).toBe(true);
  });

  it('is false when the only PR is a draft — a draft is not yet up for review', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1, 'draft')], false)).toBe(false);
  });

  it('is false when the only PR status is unknown — an unanswered probe is not review', () => {
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1, 'unknown')], false)).toBe(false);
    expect(isAwaitingReview(ticket({ stageCurrent: 'ship' }), [pr(1, null)], false)).toBe(false);
  });
});

describe('completedAt', () => {
  function doneStage(over: { endedAt: string | null; startedAt?: string | null }): TicketWithStages['stages'][number] {
    return {
      ticketId: 1,
      stageKey: 'done',
      status: 'passed',
      attempt: 0,
      verdict: 'passed',
      artifactPath: null,
      startedAt: over.startedAt ?? null,
      endedAt: over.endedAt,
      blockedKind: null,
      blockedReason: null,
      blockedAt: null,
    };
  }

  it('is the done stage endedAt when present', () => {
    const t = ticket({ stageCurrent: 'done', stages: [doneStage({ endedAt: '2026-08-11T12:00:00Z' })] });
    expect(completedAt(t)).toBe('2026-08-11T12:00:00Z');
  });

  it('falls back to the done stage startedAt when endedAt is missing', () => {
    const t = ticket({
      stageCurrent: 'done',
      stages: [doneStage({ endedAt: null, startedAt: '2026-08-11T12:00:00Z' })],
    });
    expect(completedAt(t)).toBe('2026-08-11T12:00:00Z');
  });

  it('falls back to the ticket updatedAt when no done stage row exists', () => {
    const t = ticket({ stageCurrent: 'done', stages: [], updatedAt: '2026-08-11T11:00:00Z' });
    expect(completedAt(t)).toBe('2026-08-11T11:00:00Z');
  });

  it('normalizes a SQLite space-form updatedAt so it compares correctly against ISO stage times', () => {
    // `datetime('now')` writes "2026-08-11 23:59:59"; unnormalized it would
    // sort BEFORE "2026-08-11T00:00:00Z" despite being the later instant.
    const t = ticket({ stageCurrent: 'done', stages: [], updatedAt: '2026-08-11 23:59:59' });
    expect(completedAt(t)).toBe('2026-08-11T23:59:59Z');
  });

  it('is null when no timestamp exists anywhere', () => {
    expect(completedAt(ticket({ stageCurrent: 'done', stages: [], updatedAt: null }))).toBeNull();
  });
});

describe('sub-task identity on the sidebar node', () => {
  it('flags a queued sub-task at scope (host-derived, UI-R31)', () => {
    const [q, plain, started] = buildTicketNodes([
      ticket({ subtaskParentId: 7, autostartPending: true, stageCurrent: 'scope' }),
      ticket({ subtaskParentId: null, autostartPending: true, stageCurrent: 'scope' }),
      ticket({ subtaskParentId: 7, autostartPending: true, stageCurrent: 'impl' }),
    ]);
    expect([q!.autostart, plain!.autostart, started!.autostart]).toEqual(['queued', null, null]);
    const [claimed] = buildTicketNodes([
      ticket({ subtaskParentId: 7, autostartPending: false, autostartStarting: true, stageCurrent: 'scope' }),
    ]);
    expect(claimed!.autostart).toBe('starting');
  });

  it('carries no sub-task parent for an ordinary ticket', () => {
    const [node] = buildTicketNodes([ticket({ subtaskParentId: null })]);
    expect(node!.subtaskParentId).toBeNull();
    expect(node!.subtaskParentKey).toBeNull();
    expect(node!.subtaskDepth).toBe(0);
  });

  it('resolves the sub-task parent key from the lookup map, distinct from the follow-up key', () => {
    const parentKeys = new Map([
      [1, 'PROJ-1'],
      [2, 'PROJ-1-fu1'],
    ]);
    const [node] = buildTicketNodes(
      [ticket({ id: 3, key: 'PROJ-1-s1', subtaskParentId: 1, parentTicketId: 2 })],
      undefined,
      undefined,
      parentKeys,
    );
    expect(node!.subtaskParentId).toBe(1);
    expect(node!.subtaskParentKey).toBe('PROJ-1');
    expect(node!.parentKey).toBe('PROJ-1-fu1');
  });
});

describe('nestSubtasks', () => {
  function node(over: Partial<TicketNode> & { ticketId: number }): TicketNode {
    return {
      kind: 'ticket',
      label: `t${over.ticketId}`,
      glyph: 'gray',
      description: '',
      stageLabel: '',
      stageClass: '',
      stageChip: '',
      blocker: null,
      sessionAction: { kind: 'start', label: 'Start', detail: '' },
      lastActiveAt: null,
      model: null,
      archived: false,
      parentKey: null,
      subtaskParentId: null,
      subtaskParentKey: null,
      subtaskDepth: 0,
      subtaskChildCount: 0,
      autostart: null,
      collapsible: true,
      ...over,
    };
  }

  it('puts a sub-task directly after its parent with depth 1, and nests recursively', () => {
    const rows = [
      node({ ticketId: 10 }),
      node({ ticketId: 12, subtaskParentId: 11 }),
      node({ ticketId: 11, subtaskParentId: 10 }),
      node({ ticketId: 20 }),
    ];
    const out = nestSubtasks(rows);
    expect(out.map((r) => [r.ticketId, r.subtaskDepth])).toEqual([
      [10, 0],
      [11, 1],
      [12, 2],
      [20, 0],
    ]);
  });

  it('stamps the direct child count so a row knows it can collapse', () => {
    const rows = [
      node({ ticketId: 1 }),
      node({ ticketId: 2, subtaskParentId: 1 }),
      node({ ticketId: 3, subtaskParentId: 1 }),
      node({ ticketId: 4, subtaskParentId: 2 }),
    ];
    const byId = new Map(nestSubtasks(rows).map((r) => [r.ticketId, r.subtaskChildCount]));
    expect(byId.get(1)).toBe(2);
    expect(byId.get(2)).toBe(1);
    expect(byId.get(3)).toBe(0);
    expect(byId.get(4)).toBe(0);
  });

  it('keeps a sub-task as a root when its parent is not in this list', () => {
    const rows = [node({ ticketId: 12, subtaskParentId: 99 })];
    const out = nestSubtasks(rows);
    expect(out.map((r) => [r.ticketId, r.subtaskDepth])).toEqual([[12, 0]]);
  });

  it('preserves sibling and root order from the source list', () => {
    const rows = [
      node({ ticketId: 2, subtaskParentId: 1 }),
      node({ ticketId: 1 }),
      node({ ticketId: 4, subtaskParentId: 1 }),
      node({ ticketId: 3, subtaskParentId: 1 }),
    ];
    const out = nestSubtasks(rows);
    // Root 1 first (its source position is where the tree begins), then its
    // children in source order.
    expect(out.map((r) => r.ticketId)).toEqual([1, 2, 4, 3]);
  });

  it('indents to the writer\'s deepest legal sub-task and clamps bad data', () => {
    // MAX_SUBTASK_INDENT is the writer's MAX_SUBTASK_DEPTH: depth counts
    // `-s<n>` segments, so the deepest legal sub-task is depth 4
    // (PROJ-1-s1-s1-s1-s1, pinned by the writer's own test). Depth 5+ is bad
    // data and is clamped rather than indenting off-screen.
    const rows = [1, 2, 3, 4, 5, 6].map((id) =>
      node({ ticketId: id, subtaskParentId: id === 1 ? null : id - 1 }),
    );
    const out = nestSubtasks(rows);
    expect(out.map((r) => r.subtaskDepth)).toEqual([
      0,
      1,
      2,
      3,
      MAX_SUBTASK_INDENT,
      MAX_SUBTASK_INDENT,
    ]);
    expect(MAX_SUBTASK_INDENT).toBe(MAX_SUBTASK_DEPTH);
  });
});

describe('visibleTicketRows', () => {
  function node(over: Partial<TicketNode> & { ticketId: number }): TicketNode {
    return {
      kind: 'ticket',
      label: `t${over.ticketId}`,
      glyph: 'gray',
      description: '',
      stageLabel: '',
      stageClass: '',
      stageChip: '',
      blocker: null,
      sessionAction: { kind: 'start', label: 'Start', detail: '' },
      lastActiveAt: null,
      model: null,
      archived: false,
      parentKey: null,
      subtaskParentId: null,
      subtaskParentKey: null,
      subtaskDepth: 0,
      subtaskChildCount: 0,
      autostart: null,
      collapsible: true,
      ...over,
    };
  }

  // 1 ⊃ 2 ⊃ 3, then a separate root 4.
  const tree = () =>
    nestSubtasks([
      node({ ticketId: 1 }),
      node({ ticketId: 2, subtaskParentId: 1 }),
      node({ ticketId: 3, subtaskParentId: 2 }),
      node({ ticketId: 4 }),
    ]);

  it('returns every row when nothing is collapsed', () => {
    expect(visibleTicketRows(tree(), new Set()).map((r) => r.ticketId)).toEqual([1, 2, 3, 4]);
  });

  it('collapsing a row hides its whole descendant sub-tree, keeping the row itself', () => {
    expect(visibleTicketRows(tree(), new Set([1])).map((r) => r.ticketId)).toEqual([1, 4]);
    // Collapsing a mid-tree row hides only ITS descendants.
    expect(visibleTicketRows(tree(), new Set([2])).map((r) => r.ticketId)).toEqual([1, 2, 4]);
  });

  it('a collapsed ancestor wins over a re-expanded descendant (recursive)', () => {
    // Collapsing 1 hides 3 even though 2 (its parent) is not itself collapsed.
    expect(visibleTicketRows(tree(), new Set([1])).map((r) => r.ticketId)).toEqual([1, 4]);
  });

  it('collapsing the parent of the deepest legal sub-task hides it', () => {
    // Root + MAX_SUBTASK_DEPTH levels, exactly what the writer can create. The
    // deepest row must not share its parent's depth slot, or collapsing the
    // parent would leave it visible.
    const chain = nestSubtasks(
      Array.from({ length: MAX_SUBTASK_DEPTH + 1 }, (_, i) =>
        node({ ticketId: i + 1, subtaskParentId: i === 0 ? null : i }),
      ),
    );
    const parentOfDeepest = MAX_SUBTASK_DEPTH;
    expect(
      visibleTicketRows(chain, new Set([parentOfDeepest])).map((r) => r.ticketId),
    ).toEqual(Array.from({ length: MAX_SUBTASK_DEPTH }, (_, i) => i + 1));
  });

  it('is a no-op on a flat list', () => {
    const flat = [node({ ticketId: 7 }), node({ ticketId: 8 })];
    expect(visibleTicketRows(flat, new Set([7])).map((r) => r.ticketId)).toEqual([7, 8]);
  });
});
