import { EMPTY_QUEUE } from './state.js';
import { EMPTY_ACTIVITY, type ActivityRowView } from './activity.js';
import type { QueueRowView } from './state.js';
import type { SidebarState, SidebarSections, TicketRow, SidebarPr, PlanningRow, PlanningProposalRow, DepStatus } from './state.js';
import type { SidebarWorktree } from './state.js';
import type { TicketPeek } from './peek.js';
import type { FacetKey } from './facets.js';
import { FACETS } from './facets.js';
import type { Glyph } from '../../model/glyph.js';
import { ticketRefView } from '../shared/ticketRefView.js';

/**
 * The checked-in render fixture corpus for the sidebar webview.
 *
 * Every fixture is built ONLY from production presentation shapes and is
 * pure data: no SQLite reads, no real worktrees. Ticket ids use the reserved
 * numeric band 900001–999999 (Key Decision 5). Paths and PR urls are
 * `fixture:`-prefixed. Counts is an exhaustive Record<FacetKey, number>.
 */

export type SidebarScenario =
  | 'empty'
  | 'all-sections'
  | 'done-facet'
  | 'archived-facet'
  | 'multi-facet'
  | 'filtered'
  | 'subtasks'
  | 'planning-deps'
  | 'waits-on'
  | 'planning-artifacts'
  | 'priority'
  | 'queue'
  | 'queue-long'
  | 'activity'
  | 'activity-long'
  | 'hostile'
  | 'cloud-sessions'
  | 'peek-states'
  | 'real-titles'
  | 'peek-blocked'
  | 'peek-pr-closed';

export const SIDEBAR_SCENARIOS: readonly SidebarScenario[] = [
  'empty', 'all-sections', 'done-facet', 'archived-facet', 'multi-facet', 'filtered', 'subtasks', 'planning-deps', 'waits-on', 'planning-artifacts', 'priority', 'queue', 'queue-long', 'activity', 'activity-long', 'hostile', 'cloud-sessions', 'peek-states', 'real-titles', 'peek-blocked', 'peek-pr-closed',
];

export interface SidebarRenderFixture {
  scenario: SidebarScenario;
  state: SidebarState;
}

const ALL_FACET_KEYS: FacetKey[] = FACETS.map((f) => f.key);

function fixtureCounts(overrides?: Partial<Record<FacetKey, number>>): Record<FacetKey, number> {
  const base: Record<FacetKey, number> = { all: 0, running: 0, input: 0, failed: 0, done: 0, archived: 0 };
  return { ...base, ...overrides };
}

export const HOSTILE_LABEL = '<script>alert(1)</script>';
const HOSTILE_LONG = 'W'.repeat(300);

function fixturePeek(overrides?: Partial<TicketPeek>): TicketPeek {
  return { title: 'fixture:peek', next: null, ...overrides };
}

function fixtureRow(index: number, overrides?: Partial<TicketRow>): TicketRow {
  return {
    kind: 'ticket',
    artifacts: 0,
    ticketId: 900001 + index,
    idLabel: `T${900001 + index}`,
    label: `FEAT-${100 + index}`,
    glyph: 'blue' as Glyph,
    description: `fixture:desc:${index}`,
    stageLabel: 'Implementing',
    stageClass: 'stg-impl',
    stageChip: 'impl',
    blocker: null,
    sessionAction: { kind: 'start', label: 'Start', detail: 'Start a new session' },
    lastActiveAt: null,
    model: null,
    archived: false,
    parentKey: null,
    paused: false,
    canClose: false,
    canReopen: false,
    canDetach: false,
    subtaskParentId: null,
    subtaskParentKey: null,
    subtaskDepth: 0,
    subtaskChildCount: 0,
    subtaskIsLast: false,
    subtaskGuides: [],
    autostart: null,
    collapsible: true as const,
    stageCurrent: 'impl',
    priority: null,
    prioritySource: null,
    providerPriority: null,
    providerLabel: 'ClickUp',
    priorityEditable: false,
    conflicted: false,
    ciFailing: false,
    servers: [],
    worktrees: [],
    prs: [],
    isActive: false,
    peek: fixturePeek(),
    ...overrides,
  };
}

function emptyState(): SidebarState {
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts(),
    sections: { current: [], awaitingReview: [], recentlyDone: [], olderDone: [] },
    done: [],
    rows: [],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [],
    unlinkedCloudSessions: [],
  };
}

/** A draft row with its host-built `D<n>` / `T<n>` labels derived from the raw ids. */
export function fixtureDraft(
  d: Pick<PlanningProposalRow, 'id' | 'title' | 'status' | 'ticketId' | 'dependsOn'> & Partial<PlanningProposalRow>,
): PlanningProposalRow {
  return {
    idLabel: `D${d.id}`,
    ticketIdLabel: d.ticketId === null ? null : `T${d.ticketId}`,
    dependsOnLabels: d.dependsOn.map((n) => (typeof n === 'string' ? n : `D${n}`)),
    dependsOnStatus: [],
    ...(d.droppedDepends ? { droppedLabels: d.droppedDepends.map((n) => `D${n}`) } : {}),
    ...d,
  };
}

export function fixturePlanningRow(sessionId: number, overrides: Partial<PlanningRow> = {}): PlanningRow {
  return {
    sessionId,
    idLabel: `P${sessionId}`,
    title: `Planning ${sessionId}`,
    status: 'active',
    ticketCount: 0,
    artifacts: 0,
    live: false,
    agent: { provider: 'claude', model: 'opus' },
    proposals: [],
    ...overrides,
  };
}

function allSectionsState(): SidebarState {
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts({ all: 6, running: 2, input: 1, failed: 1, done: 1 }),
    sections: {
      // `all-sections` is the sidebar's visual-sweep seed, so the CURRENT
      // section carries a three-level sub-tree (depth 0 → 1 → 2). The nested
      // rows are what the baseline pins about how a ticket with its sub-tasks
      // renders — the guides, the indented chevron and the collapse controls —
      // which flat rows alone cannot show.
      current: [
        fixtureRow(0, { glyph: 'blue', subtaskChildCount: 1 }),
        fixtureRow(1, {
          label: 'FEAT-100-s1',
          glyph: 'amber',
          subtaskParentId: 900001,
          subtaskParentKey: 'FEAT-100',
          subtaskDepth: 1,
          subtaskChildCount: 1,
          subtaskIsLast: true,
          subtaskGuides: [true],
        }),
        fixtureRow(2, {
          label: 'FEAT-100-s1-s1',
          glyph: 'red',
          subtaskParentId: 900002,
          subtaskParentKey: 'FEAT-100-s1',
          subtaskDepth: 2,
          subtaskIsLast: true,
          subtaskGuides: [false, false],
          blocker: { reason: 'gate failed', attempt: 2 },
        }),
      ],
      awaitingReview: [fixtureRow(5, { glyph: 'amber', stageLabel: 'Ship', stageClass: 'stg-ship', stageChip: 'ship', stageCurrent: 'ship', prs: [{ repo: 'backend', number: 1, url: 'fixture:pr/1', status: 'open' }] })],
      recentlyDone: [fixtureRow(3, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' })],
      olderDone: [fixtureRow(4, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' })],
    },
    done: [],
    rows: [],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [fixturePlanningRow(90, { live: true, ticketCount: 2, status: 'filed', proposals: [fixtureDraft({ id: 501, title: 'Add rate limit', status: 'pending', ticketId: null, dependsOn: [] }), fixtureDraft({ id: 503, title: 'Split auth module', status: 'accepted', ticketId: 3, dependsOn: [501] })] }), fixturePlanningRow(89)],
    unlinkedCloudSessions: [],
  };
}

function doneFacetState(): SidebarState {
  const doneRows = [
    fixtureRow(0, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' }),
    fixtureRow(1, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' }),
  ];
  return {
    facets: ['done'],
    filter: '',
    counts: fixtureCounts({ all: 2, done: 2 }),
    sections: { current: [], awaitingReview: [], recentlyDone: [], olderDone: [] },
    done: doneRows,
    rows: [],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [],
    unlinkedCloudSessions: [],
  };
}

function archivedFacetState(): SidebarState {
  return {
    facets: ['archived'],
    filter: '',
    counts: fixtureCounts({ archived: 3 }),
    sections: { current: [], awaitingReview: [], recentlyDone: [], olderDone: [] },
    done: [],
    rows: [
      fixtureRow(0, { label: 'DELETED-1', glyph: 'gray' }),
      fixtureRow(1, { label: 'DELETED-2', glyph: 'gray' }),
      fixtureRow(2, { label: 'DELETED-3', glyph: 'gray' }),
    ],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [fixturePlanningRow(77, { title: 'Old plan', status: 'archived' })],
    unlinkedCloudSessions: [],
  };
}

function multiFacetState(): SidebarState {
  return {
    facets: ['running', 'failed'],
    filter: '',
    counts: fixtureCounts({ all: 4, running: 2, failed: 2 }),
    sections: { current: [], awaitingReview: [], recentlyDone: [], olderDone: [] },
    done: [],
    rows: [
      fixtureRow(0, { glyph: 'blue' }),
      fixtureRow(1, { glyph: 'blue' }),
      fixtureRow(2, { glyph: 'red' }),
      fixtureRow(3, { glyph: 'red' }),
    ],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [],
    unlinkedCloudSessions: [],
  };
}

function filteredState(): SidebarState {
  return {
    facets: ['all'],
    filter: 'auth',
    counts: fixtureCounts({ all: 3, running: 1 }),
    sections: {
      current: [fixtureRow(0, { label: 'FEAT-auth-flow', glyph: 'blue' })],
      awaitingReview: [],
      recentlyDone: [],
      olderDone: [],
    },
    done: [],
    rows: [],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [],
    unlinkedCloudSessions: [],
  };
}

function subtasksState(): SidebarState {
  // Host output: rows already ordered parent-first with depths stamped
  // (`nestSubtasks`), so the webview only paints indentation, the marker and
  // the collapse control (a row with `subtaskChildCount > 0`).
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts({ all: 4, running: 3 }),
    sections: {
      current: [
        fixtureRow(0, { label: 'FEAT-100', glyph: 'blue', subtaskChildCount: 1 }),
        fixtureRow(1, {
          label: 'FEAT-100-s1',
          glyph: 'blue',
          subtaskParentId: 900001,
          subtaskParentKey: 'FEAT-100',
          subtaskDepth: 1,
          subtaskChildCount: 1,
          subtaskIsLast: true,
          subtaskGuides: [true],
          // Two blockers so the narrow layout tiers exercise banner wrapping
          // instead of only the one-chip case.
          blockedBy: [ticketRefView({ ref: 'BLOCK-7' }), ticketRefView({ ref: 'BLOCK-8' })],
        }),
        fixtureRow(2, {
          label: 'FEAT-100-s1-s1',
          glyph: 'amber',
          subtaskParentId: 900002,
          subtaskParentKey: 'FEAT-100-s1',
          subtaskDepth: 2,
          subtaskIsLast: true,
          subtaskGuides: [false, false],
          // Waiting for the autostart sweep — renders "Queued", not "scope".
          stageChip: 'scope',
          stageClass: 'stg-scope',
          autostart: 'queued',
        }),
        fixtureRow(3, { label: 'FEAT-101', glyph: 'blue' }),
      ],
      awaitingReview: [],
      recentlyDone: [],
      olderDone: [],
    },
    done: [],
    rows: [],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [],
    unlinkedCloudSessions: [],
  };
}

function hostileState(): SidebarState {
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts({ all: 1 }),
    sections: {
      current: [
        fixtureRow(0, { label: HOSTILE_LABEL, description: HOSTILE_LONG, peek: fixturePeek({ title: HOSTILE_LABEL }) }),
      ],
      awaitingReview: [],
      recentlyDone: [],
      olderDone: [],
    },
    done: [],
    rows: [],
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [fixturePlanningRow(91, { title: HOSTILE_LABEL, proposals: [fixtureDraft({ id: 502, title: HOSTILE_LABEL, status: 'pending', ticketId: null, dependsOn: [] })], agent: { provider: 'claude', model: '<img src=x onerror=alert(1)>' } })],
    unlinkedCloudSessions: [],
  };
}

/** One session whose last draft depends on a pending draft, a live ticket and a done ticket. */
function planningDepsState(): SidebarState {
  const dependsOnStatus = [
    ticketRefView({ draftId: 94, draftLabel: 'D94' }),
    ticketRefView({
      draftId: 92,
      draftLabel: 'D92',
      ticket: { id: 605, key: 'DEP-1', stageCurrent: 'impl', stages: [{ stageKey: 'impl', status: 'running' }] } as any,
      glyph: 'blue',
    }),
    ticketRefView({
      draftId: 91,
      draftLabel: 'D91',
      ticket: { id: 604, key: 'DEP-2', stageCurrent: 'done', stages: [{ stageKey: 'done', status: 'passed' }] } as any,
      glyph: 'green',
    }),
  ];
  const crossSession: DepStatus = ticketRefView({ draftId: 498, draftLabel: 'D498', sessionLabel: 'P43' });
  const directTicket: DepStatus = ticketRefView({
    ticket: { id: 610, key: 'DEP-3', stageCurrent: 'impl', stages: [{ stageKey: 'impl', status: 'running' }] } as any,
  });
  return {
    ...emptyState(),
    sections: { current: [fixtureRow(0, { glyph: 'blue' })], awaitingReview: [], recentlyDone: [], olderDone: [] },
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [fixturePlanningRow(17, {
      title: 'Sidebar drafts',
      proposals: [
        fixtureDraft({ id: 94, title: 'Pending prerequisite', status: 'pending', ticketId: null, dependsOn: [] }),
        fixtureDraft({ id: 95, title: 'Needs three things', status: 'pending', ticketId: null, dependsOn: [94, 92, 91], dependsOnStatus }),
        fixtureDraft({ id: 97, title: 'Needs another session and a ticket', status: 'pending', ticketId: null, dependsOn: [498, 'T610'], dependsOnStatus: [crossSession, directTicket] }),
        fixtureDraft({ id: 96, title: 'Accepted with deps', status: 'accepted', ticketId: 606, dependsOn: [92, 91], dependsOnStatus: dependsOnStatus.slice(1) }),
      ],
    })],
  };
}

/** T1213: planning rows with the Open artifacts action (live, long title, archived) and one without (no files). */
function planningArtifactsState(): SidebarState {
  return {
    ...allSectionsState(),
    planning: [
      fixturePlanningRow(95, { live: true, artifacts: 3, title: 'Plan the sidebar planning tree artifacts action with a long title' }),
      fixturePlanningRow(94, { status: 'archived', artifacts: 1 }),
      fixturePlanningRow(93),
    ],
  };
}

/** T1103: rows with one, three and no "Waits on" references (+N list at 460px and 300px, @ui:UI-R57). */
function waitsOnState(): SidebarState {
  const dep = (id: number, key: string, stage: string) =>
    ticketRefView({ ticket: { id, key, stageCurrent: stage, stages: [{ stageKey: stage, status: 'running' }] } as any });
  return {
    ...emptyState(),
    sections: {
      current: [
        fixtureRow(0, { label: 'Waits on three things', glyph: 'blue', blockedBy: [dep(610, 'DEP-3', 'impl'), dep(611, 'DEP-4', 'review'), ticketRefView({ draftId: 94, draftLabel: 'D94' })] }),
        fixtureRow(1, { label: 'Waits on one thing', glyph: 'blue', blockedBy: [dep(612, 'DEP-5', 'uat')] }),
        fixtureRow(2, { label: 'Waits on nothing', glyph: 'blue' }),
      ],
      awaitingReview: [],
      recentlyDone: [],
      olderDone: [],
    },
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
  };
}

/** Priority chips: a draft at every level, a planner reason, a user override, and not-started tickets at every level. */
function priorityState(): SidebarState {
  // A ticket's chip: the effective level, who set it, and the provider's own level beside a user value.
  const scoped = (
    index: number,
    priority: TicketRow['priority'],
    prioritySource: TicketRow['prioritySource'] = priority === null ? null : 'provider',
    providerPriority: TicketRow['providerPriority'] = prioritySource === 'provider' ? priority : null,
  ): TicketRow =>
    fixtureRow(index, { stageCurrent: 'scope', stageLabel: 'Not scoped', stageClass: 'stg-scope', stageChip: 'scope', priority, prioritySource, providerPriority, priorityEditable: true, glyph: 'gray' });
  const draft = (id: number, title: string, priority?: PlanningProposalRow['priority']): PlanningProposalRow =>
    fixtureDraft({ id, title, status: 'pending', ticketId: null, dependsOn: [], ...(priority ? { priority } : {}) });
  return {
    ...emptyState(),
    counts: fixtureCounts({ all: 4 }),
    sections: {
      // Four rows keep the screenshot unchanged: only the tooltip and aria text carry the source.
      current: [
        scoped(0, 'urgent'), // provider only (a cleared override falls back to this)
        scoped(1, 'high', 'you'), // user only
        scoped(2, null), // no priority
        scoped(3, 'low', 'you', 'high'), // user and provider differ: `Low · set by you (ClickUp: High)`
      ],
      awaitingReview: [], recentlyDone: [], olderDone: [] },
    queue: EMPTY_QUEUE,
    activity: EMPTY_ACTIVITY,
    planning: [fixturePlanningRow(17, {
      title: 'Prioritized drafts',
      proposals: [
        draft(101, 'Urgent with a planner reason', { level: 'urgent', source: 'planner', reason: 'Gate runs leak processes after a reload' }),
        draft(102, 'High set by you', { level: 'high', source: 'you' }),
        draft(103, 'Normal shows no chip', { level: 'normal', source: 'planner' }),
        draft(104, 'Low from the planner', { level: 'low', source: 'planner' }),
        draft(105, 'No priority'),
      ],
    })],
  };
}

/** A ticket with several cloud sessions (D325 / D241). */
function cloudSessionsState(): SidebarState {
  return {
    ...emptyState(),
    facets: ['all'],
    filter: '',
    counts: fixtureCounts({ all: 1, running: 1 }),
    sections: {
      current: [
        fixtureRow(0, {
          label: 'FEAT-multiple-cloud',
          glyph: 'blue',
          cloudSessions: [
            {
              provider: 'claude',
              label: 'Claude Code on the web',
              url: 'fixture:cloud/session-2',
              linkSource: 'branch',
              firstSeen: '2026-10-29T10:05:00.000Z',
            },
            {
              provider: 'claude',
              label: 'Claude Code on the web',
              url: 'fixture:cloud/session-1',
              linkSource: 'pr',
              firstSeen: '2026-10-29T10:00:00.000Z',
            },
          ],
        }),
      ],
      awaitingReview: [],
      recentlyDone: [],
      olderDone: [],
    },
  };
}

export function fixtureQueueRow(position: number, overrides: Partial<QueueRowView> = {}): QueueRowView {
  const id = 450 + position;
  return {
    position, kind: 'draft', id, idLabel: `D${id}`, sessionLabel: 'P17', sessionTitle: 'offloading', title: `Queue item ${position}`,
    level: 'normal', inheritedFrom: null, waitsOn: [], unblocks: [], waitsOnRefs: [], inheritedRef: null, cycleRef: null, cycle: false, why: '', whyKind: 'none', ownLevel: null,
    prioritySource: null, providerPriority: null, providerLabel: null,
    ...overrides,
  };
}

/** Raised blocker, urgent and high drafts, a waiting draft, a scope ticket and a cycle: every reason kind. */
function queueRows(): QueueRowView[] {
  const draftRef = (n: number, session = 'P17') => ticketRefView({ draftId: n, draftLabel: `D${n}`, sessionLabel: session });
  const ticketRef = (id: number, stage: string) => ticketRefView({ ticketId: id, stage });
  return [
    fixtureQueueRow(1, { id: 497, idLabel: 'D497', title: 'Add the shared retry helper', level: 'urgent', inheritedFrom: 'D498', inheritedRef: draftRef(498), unblocks: ['D498'], why: 'unblocks D498', whyKind: 'raised' }),
    fixtureQueueRow(2, { id: 498, idLabel: 'D498', title: 'Fix the data loss on a failed accept', level: 'urgent', ownLevel: 'urgent', waitsOn: ['D497'], waitsOnRefs: [draftRef(497)], why: 'waits on D497', whyKind: 'waits' }),
    fixtureQueueRow(3, { id: 452, idLabel: 'D452', title: 'Split the auth module', level: 'high', ownLevel: 'high', sessionLabel: 'P18', sessionTitle: 'auth' }),
    fixtureQueueRow(4, { kind: 'ticket', id: 997, idLabel: 'T997', sessionLabel: null, title: 'Cut the cold start of the sidebar', waitsOn: ['T12', 'T13'], waitsOnRefs: [ticketRef(12, 'impl'), ticketRef(13, 'review')], why: 'waits on T12 +1', whyKind: 'waits' }),
    fixtureQueueRow(5, { id: 460, idLabel: 'D460', title: 'Rename the stage runner option', level: 'low', ownLevel: 'low' }),
    fixtureQueueRow(6, { id: 461, idLabel: 'D461', title: 'Move the gate log to its own table', why: 'cycle with D462', whyKind: 'cycle', cycle: true, cycleRef: draftRef(462), waitsOn: ['D462'], waitsOnRefs: [draftRef(462)] }),
  ];
}

function queueState(): SidebarState {
  const rows = queueRows();
  return { ...allSectionsState(), queue: { rows, drafts: 5, sessions: 2, tickets: 1 } };
}

function queueLongState(): SidebarState {
  const rows = Array.from({ length: 40 }, (_, i) =>
    fixtureQueueRow(i + 1, { title: i % 7 === 0 ? `A very long queue item title ${i + 1} that must end in an ellipsis and never wrap` : `Queue item ${i + 1}`, ...(i % 5 === 0 ? { level: 'high' as const, inheritedFrom: 'D400', inheritedRef: ticketRefView({ draftId: 400, draftLabel: 'D400', sessionLabel: 'P17' }), why: 'unblocks D400', whyKind: 'raised' as const } : {}) }),
  );
  return { ...allSectionsState(), queue: { rows, drafts: 40, sessions: 4, tickets: 0 } };
}

/** A fixed event time: `day` days after 2026-01-01, at `hour:minute` UTC. Far in the past, so the day label is a date at any clock. */
const activityAt = (day: number, hour: number, minute: number): string => new Date(Date.UTC(2026, 0, 1 + day, hour, minute)).toISOString();

function activityState(): SidebarState {
  const rows: ActivityRowView[] = [
    { id: 8, level: 'error', title: 'Autopilot: auto-fix stopped after 3 rounds', ticketId: 900001, ticketLabel: 'T900001', createdAt: activityAt(5, 14, 30), unread: true },
    { id: 7, level: 'warn', title: 'Autopilot: auto-fix did not run', ticketId: 900002, ticketLabel: 'T900002', createdAt: activityAt(5, 11, 5), unread: true },
    { id: 6, level: 'success', title: 'Merged 2 pull requests', ticketId: 900003, ticketLabel: 'T900003', createdAt: activityAt(4, 17, 45), unread: false },
    { id: 5, level: 'info', title: 'Karst finished a background check', ticketId: null, ticketLabel: null, createdAt: activityAt(4, 9, 0), unread: false },
  ];
  return { ...allSectionsState(), activity: { rows, unread: 2, total: 4, hasMore: false } };
}

function activityLongState(): SidebarState {
  const levels = ['info', 'success', 'warn', 'error'] as const;
  const rows: ActivityRowView[] = Array.from({ length: 50 }, (_, i) => ({
    id: 100 - i,
    level: levels[i % 4]!,
    title: i % 6 === 0 ? `A very long activity title ${i} that must end in an ellipsis and never wrap or scroll the pane sideways` : `Activity ${i}`,
    ticketId: i % 3 === 0 ? null : 900001 + (i % 5),
    ticketLabel: i % 3 === 0 ? null : `T${900001 + (i % 5)}`,
    createdAt: activityAt(10 - Math.floor(i / 10), 20 - (i % 10), (i * 7) % 60),
    unread: i < 12,
  }));
  return { ...allSectionsState(), activity: { rows, unread: 12, total: 120, hasMore: true } };
}

/** The ticket ids of the `peek-states` rows: the visual variants open each one by its chevron. */
export const PEEK_STATE_IDS: readonly number[] = [900001, 900002, 900003, 900004, 900005, 900006, 900007];

const PEEK_AT = '2026-01-01T00:00:00.000Z';
const PEEK_AGENT = { provider: 'claude', model: 'opus', activity: 'working', activeAt: PEEK_AT } as const;

/** One expanded row per state family: working, paused, failed gates, ship confirm, merge, conflict, shipped. */
function peekStatesState(): SidebarState {
  const wh = [{ repo: 'fixture:karst', repoDisplay: 'karst' }, { repo: 'fixture:karst-docs', repoDisplay: 'karst-docs' }] as unknown as TicketRow['worktrees'];
  const rows: TicketRow[] = [
    fixtureRow(0, { glyph: 'blue', worktrees: wh, peek: fixturePeek({ title: 'Agent working', tone: 'blue', since: { at: PEEK_AT, kind: 'for' }, agent: PEEK_AGENT }) }),
    fixtureRow(1, { glyph: 'gray' as Glyph, paused: true, peek: fixturePeek({ title: 'Paused', since: { at: PEEK_AT, kind: 'for' }, pausedNote: 'No stage starts until you resume' }) }),
    fixtureRow(2, { glyph: 'red', peek: fixturePeek({ title: 'Impl failed', tone: 'red', since: { at: PEEK_AT, kind: 'ago' }, attempt: 2, gates: { text: '2 failed: lint, test · 3 passed', tone: 'failed' }, agent: PEEK_AGENT, next: { kind: 'send-ci-failure', label: 'Send CI failure to agent' } }) }),
    fixtureRow(3, { glyph: 'amber', stageCurrent: 'ship', peek: fixturePeek({ title: 'Ready to ship', tone: 'amber', since: { at: PEEK_AT, kind: 'ago' }, needs: { detail: 'The gates passed. Confirm to open the pull requests.', action: 'Confirm ship', cta: { kind: 'ship-confirm' } } as never }) }),
    fixtureRow(4, { glyph: 'amber', stageCurrent: 'ship', peek: fixturePeek({ title: 'Awaiting merge', tone: 'amber', since: { at: PEEK_AT, kind: 'for' }, repos: [{ repo: 'karst', number: 1148, state: 'ready' }, { repo: 'karst-docs', number: 77, state: 'ready' }], needs: { detail: 'Merge #1148 in karst.', action: 'Merge', cta: { kind: 'merge', repo: 'karst' } } as never }) }),
    fixtureRow(5, { glyph: 'red', stageCurrent: 'ship', peek: fixturePeek({ title: 'Merge conflict', tone: 'red', since: { at: PEEK_AT, kind: 'for' }, repos: [{ repo: 'karst', number: 1148, state: 'conflict' }], needs: { detail: 'karst has a merge conflict.', action: 'Resolve', cta: { kind: 'resolve-conflicts', repo: 'karst' } } as never }) }),
    fixtureRow(6, { glyph: 'green', stageCurrent: 'done', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done', worktrees: wh, peek: fixturePeek({ title: 'Shipped', tone: 'green', since: { at: PEEK_AT, kind: 'ago' }, next: { kind: 'create-follow-up', label: 'Create follow-up' } }) }),
  ];
  return { ...allSectionsState(), sections: { current: rows, awaitingReview: [], recentlyDone: [], olderDone: [] } };
}

/** SB-3 (T1318): the 15 titles of the real probe, so the real-width shot records real rows, not fixture ids. */
const REAL_TITLES: readonly string[] = [
  'Fix the sidebar empty state on a cold start',
  'One shape and one word for every ticket state',
  'Status bar reads the shared state word',
  'Queue pane scrolls sideways at 300 px',
  'Activity keeps three rows at 700 px',
  'Peek shows the stage block as its headline',
  'A closed pull request says PR closed',
  'The Tickets tree takes one tab stop',
  'A filtered count reads shown over total',
  'A long ticket title never moves the stage pill',
  'The stage pill uses the short key at the tight tier',
  'The settings nav follows the mid tier',
  'The usage pager counts the filtered rows',
  'The resources inventory hides empty servers',
  'Getting started marks the finished steps',
];

/** One stage per glyph colour: blue runs, amber needs you, red failed, green done, gray pending. */
const REAL_STAGES = {
  impl: { label: 'Implementing', cls: 'stg-impl', chip: 'impl', current: 'impl' },
  uat: { label: 'Validating', cls: 'stg-uat', chip: 'uat', current: 'uat' },
  review: { label: 'Reviewing', cls: 'stg-review', chip: 'review', current: 'review' },
  ship: { label: 'Shipping', cls: 'stg-ship', chip: 'ship', current: 'ship' },
  scope: { label: 'Not scoped', cls: 'stg-scope', chip: 'scope', current: 'scope' },
  done: { label: 'Done', cls: 'stg-done', chip: 'done', current: 'done' },
} as const;

function realTicket(index: number, glyph: Glyph, stage: keyof typeof REAL_STAGES, extra: Partial<TicketRow> = {}): TicketRow {
  const s = REAL_STAGES[stage];
  return fixtureRow(index, {
    label: REAL_TITLES[index]!,
    glyph,
    stageLabel: s.label,
    stageClass: s.cls,
    stageChip: s.chip,
    stageCurrent: s.current,
    peek: fixturePeek({ title: REAL_TITLES[index]!, tone: glyph }),
    ...extra,
  });
}

/**
 * SB-3 (T1318): the populated sidebar at the real ~300 px host width: 15 rows with the probe's
 * titles, the plan and the Activity rows. `sidebar/populated-300` pins a real page, and the
 * Activity floor (three rows at 700 px, SB-7) is measured on rows a user would see.
 */
function realTitlesState(): SidebarState {
  const current = [
    realTicket(0, 'blue', 'impl'),
    realTicket(1, 'blue', 'uat'),
    realTicket(2, 'blue', 'review'),
    realTicket(3, 'blue', 'impl'),
    realTicket(4, 'amber', 'scope'),
    realTicket(5, 'amber', 'ship'),
    realTicket(6, 'red', 'impl'),
    realTicket(7, 'gray', 'scope'),
    realTicket(8, 'gray', 'scope'),
    realTicket(9, 'gray', 'scope'),
    realTicket(10, 'amber', 'scope'),
  ];
  const rows: ActivityRowView[] = [
    { id: 8, level: 'error', title: 'Autopilot: auto-fix stopped after 3 rounds', ticketId: 900001, ticketLabel: 'T900001', createdAt: activityAt(5, 14, 30), unread: true },
    { id: 7, level: 'warn', title: 'Autopilot: auto-fix did not run', ticketId: 900002, ticketLabel: 'T900002', createdAt: activityAt(5, 11, 5), unread: true },
    { id: 6, level: 'success', title: 'Merged 2 pull requests', ticketId: 900013, ticketLabel: 'T900013', createdAt: activityAt(4, 17, 45), unread: false },
    { id: 5, level: 'info', title: 'Karst finished a background check', ticketId: null, ticketLabel: null, createdAt: activityAt(4, 9, 0), unread: false },
  ];
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts({ all: 15, running: 5, input: 3, failed: 2, done: 2 }),
    sections: {
      current,
      awaitingReview: [realTicket(11, 'blue', 'ship'), realTicket(12, 'red', 'ship')],
      recentlyDone: [realTicket(13, 'green', 'done')],
      olderDone: [realTicket(14, 'green', 'done')],
    },
    done: [],
    rows: [],
    queue: EMPTY_QUEUE,
    activity: { rows, unread: 2, total: 4, hasMore: false },
    planning: [
      fixturePlanningRow(88, { ticketCount: 2, proposals: [fixtureDraft({ id: 601, title: 'Split the sidebar state builder', status: 'pending', ticketId: null, dependsOn: [] })] }),
      fixturePlanningRow(87),
    ],
    unlinkedCloudSessions: [],
  };
}

/**
 * RD-4/RD-5 (T1318): the two stage blocks as the peek headline, from the real probe (T8 review-stalled,
 * T5 unmapped-repository). A stage block is amber ("needs you", `@arch:BLOCKED`); the words are `BLOCK_TITLE`.
 */
function peekBlockedState(): SidebarState {
  return {
    ...emptyState(),
    counts: fixtureCounts({ all: 2, input: 2 }),
    sections: {
      current: [
        fixtureRow(7, {
          label: 'T8 review stalled on round 2',
          glyph: 'amber',
          stageCurrent: 'review',
          stageLabel: 'Reviewing',
          stageClass: 'stg-review',
          stageChip: 'review',
          peek: fixturePeek({
            title: 'Review stalled',
            tone: 'amber',
            since: { at: PEEK_AT, kind: 'for' },
            gates: { text: 'Round 2 was consumed without a verdict', tone: 'neutral' },
            needs: { detail: 'Restart the review loop from the dashboard.', action: 'Open dashboard', cta: { kind: 'graph-panel' } },
          }),
        }),
        fixtureRow(5, {
          label: 'T5 repository not in the manifest',
          glyph: 'amber',
          stageCurrent: 'scope',
          stageLabel: 'Not scoped',
          stageClass: 'stg-scope',
          stageChip: 'scope',
          peek: fixturePeek({
            title: 'Repository not mapped',
            tone: 'amber',
            gates: { text: 'karst-docs is not in karst.yml', tone: 'neutral' },
            needs: { detail: 'Map karst-docs before the worktree starts.', action: 'Open session', cta: { kind: 'open-session' } },
          }),
        }),
      ],
      awaitingReview: [],
      recentlyDone: [],
      olderDone: [],
    },
  };
}

/** RD-3 (T1318): a closed pull request keeps the ship family and reads "PR closed" (probe T12). */
function peekPrClosedState(): SidebarState {
  return {
    ...emptyState(),
    counts: fixtureCounts({ all: 1, input: 1 }),
    sections: {
      current: [
        fixtureRow(12, {
          label: 'T12 pull request closed outside Karst',
          glyph: 'red',
          stageCurrent: 'ship',
          stageLabel: 'Shipping',
          stageClass: 'stg-ship',
          stageChip: 'ship',
          prs: [{ repo: 'karst', number: 1148, url: 'fixture:pr/1148', status: 'closed' }],
          peek: fixturePeek({
            title: 'PR closed',
            tone: 'red',
            since: { at: PEEK_AT, kind: 'for' },
            repos: [{ repo: 'karst', number: 1148, state: 'closed' }, { repo: 'karst-docs', number: 77, state: 'ready' }],
            needs: { detail: 'karst has a closed pull request.', action: 'Open dashboard', cta: { kind: 'merge-panel' } },
          }),
        }),
      ],
      awaitingReview: [],
      recentlyDone: [],
      olderDone: [],
    },
  };
}

const BUILDERS: Readonly<Record<SidebarScenario, () => SidebarState>> = {
  empty: emptyState,
  'all-sections': allSectionsState,
  'done-facet': doneFacetState,
  'archived-facet': archivedFacetState,
  'multi-facet': multiFacetState,
  filtered: filteredState,
  subtasks: subtasksState,
  'planning-deps': planningDepsState,
  'waits-on': waitsOnState,
  'planning-artifacts': planningArtifactsState,
  priority: priorityState,
  queue: queueState,
  'queue-long': queueLongState,
  activity: activityState,
  'activity-long': activityLongState,
  hostile: hostileState,
  'cloud-sessions': cloudSessionsState,
  'peek-states': peekStatesState,
  'real-titles': realTitlesState,
  'peek-blocked': peekBlockedState,
  'peek-pr-closed': peekPrClosedState,
};

export function sidebarRenderFixtures(): SidebarRenderFixture[] {
  return SIDEBAR_SCENARIOS.map((scenario) => ({ scenario, state: BUILDERS[scenario]() }));
}
