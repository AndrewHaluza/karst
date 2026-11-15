import { describe, expect, it } from 'vitest';
import { MAX_SUBTASK_DEPTH } from '../../../workflow/stages/subtask.js';
import { FACETS } from '../facets.js';
import { sidebarRenderFixtures } from '../renderFixtures.js';
import type { QueueRowView, SidebarState, TicketRow } from '../state.js';
import { EMPTY_STATE, FACET_META, MAX_SUBTASK_INDENT, allRows, findRow, metaLine, relTime, visibleRows, withStateDefaults } from './format.js';

const fixtures = sidebarRenderFixtures();
const baseRow = fixtures.find((f) => f.scenario === 'all-sections')!.state.sections.current[0]!;
const row = (id: number, depth: number, over: Partial<TicketRow> = {}): TicketRow => ({ ...baseRow, ticketId: id, subtaskDepth: depth, ...over });

describe('MAX_SUBTASK_INDENT', () => {
  it('equals the writer depth, so a deeper writer change cannot outrun the painted indent (TS→CSS constant, UI-R34)', () => {
    expect(MAX_SUBTASK_INDENT).toBe(MAX_SUBTASK_DEPTH);
  });
});

describe('FACET_META', () => {
  it('lists every host facet once, in the host order', () => {
    expect(FACET_META.map((f) => f.key)).toEqual(FACETS.map((f) => f.key));
  });
});

describe('relTime', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('is empty for a missing or unparsable timestamp', () => {
    expect(relTime(null, now)).toBe('');
    expect(relTime('', now)).toBe('');
    expect(relTime('garbage', now)).toBe('');
  });
  it('steps just now → minutes → hours → days', () => {
    expect(relTime(ago(10_000), now)).toBe('just now');
    expect(relTime(ago(44_000), now)).toBe('just now');
    expect(relTime(ago(5 * 60_000), now)).toBe('5m ago');
    expect(relTime(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(relTime(ago(50 * 3_600_000), now)).toBe('2d ago');
  });
  it('treats a future timestamp as just now, never a negative age', () => {
    expect(relTime(new Date(now + 60_000).toISOString(), now)).toBe('just now');
  });
});

describe('metaLine', () => {
  it('joins model, repos, ports and PRs, omitting empty tokens instead of printing dashes', () => {
    expect(metaLine(row(1, 0))).toBe('');
    const full = row(1, 0, {
      model: 'opus',
      worktrees: [{ repo: '/x/api', repoDisplay: 'api' }, { repo: 'web', repoDisplay: '' }] as never,
      servers: [{ port: 3000 }, { port: 0 }, { port: 4000 }] as never,
      prs: [{ repo: 'api', number: 12, url: null, status: 'open' }, { repo: 'web', number: null, url: null, status: null }],
    });
    expect(metaLine(full)).toBe('opus · api+web · :3000, :4000 · PR #12');
  });
});

describe('visibleRows', () => {
  const rows = [row(1, 0), row(2, 1), row(3, 2), row(4, 1), row(5, 0)];
  it('is the identity while nothing is collapsed', () => {
    expect(visibleRows(rows, new Set())).toBe(rows);
  });
  it('drops every descendant of a collapsed row, recursively, and keeps the row itself', () => {
    expect(visibleRows(rows, new Set([1])).map((r) => r.ticketId)).toEqual([1, 5]);
    expect(visibleRows(rows, new Set([2])).map((r) => r.ticketId)).toEqual([1, 2, 4, 5]);
  });
  it('does not hide a sibling of the collapsed row', () => {
    expect(visibleRows(rows, new Set([5])).map((r) => r.ticketId)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('findRow', () => {
  it('finds a row in any section, the done list or the flat list', () => {
    const s = fixtures.find((f) => f.scenario === 'all-sections')!.state;
    expect(allRows(s).length).toBeGreaterThan(3);
    for (const r of allRows(s)) expect(findRow(s, r.ticketId)).toBe(r);
    expect(findRow(s, -1)).toBeNull();
    const done = fixtures.find((f) => f.scenario === 'done-facet')!.state;
    expect(findRow(done, done.done[0]!.ticketId)).toBe(done.done[0]);
  });
});

describe('withStateDefaults', () => {
  const queueFixture = (): SidebarState => sidebarRenderFixtures().find((f) => f.scenario === 'queue')!.state;

  it('returns the empty state when there is no snapshot', () => {
    expect(withStateDefaults(undefined)).toBe(EMPTY_STATE);
  });

  it('keeps a current state unchanged in value', () => {
    const state = queueFixture();
    expect(withStateDefaults(state)).toEqual(state);
  });

  it('fills every row field an older snapshot does not have, and keeps the identity', () => {
    const old = { position: 1, kind: 'draft', id: 7, idLabel: 'D7', title: 'Old row' } as unknown as QueueRowView;
    const state = { ...queueFixture(), queue: { rows: [old], drafts: 1, sessions: 1, tickets: 0 } };
    const row = withStateDefaults(state).queue.rows[0]!;
    expect(row).toMatchObject({ position: 1, kind: 'draft', id: 7, idLabel: 'D7', title: 'Old row' });
    expect(row).toMatchObject({ sessionLabel: null, sessionTitle: null, level: 'normal', inheritedFrom: null, cycle: false, why: '', whyKind: 'none' });
    expect(row).toMatchObject({ waitsOn: [], unblocks: [], waitsOnRefs: [], inheritedRef: null, cycleRef: null });
    expect(row).toMatchObject({ ownLevel: null, prioritySource: null, providerPriority: null, providerLabel: null });
  });

  it('fills a missing queue and a queue with no row list', () => {
    const noQueue = { ...queueFixture(), queue: undefined } as unknown as SidebarState;
    expect(withStateDefaults(noQueue).queue).toEqual(EMPTY_STATE.queue);
    const noRows = { ...queueFixture(), queue: { drafts: 2 } } as unknown as SidebarState;
    expect(withStateDefaults(noRows).queue).toEqual({ ...EMPTY_STATE.queue, drafts: 2 });
  });

  it('does not change the snapshot it receives', () => {
    const old = { position: 1, kind: 'ticket', id: 3, idLabel: 'T3', title: 'x' } as unknown as QueueRowView;
    const state = { ...queueFixture(), queue: { rows: [old], drafts: 0, sessions: 0, tickets: 1 } };
    withStateDefaults(state);
    expect(old).not.toHaveProperty('unblocks');
  });
});
