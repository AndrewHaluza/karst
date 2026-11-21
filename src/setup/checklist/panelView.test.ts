import { describe, it, expect } from 'vitest';
import { buildAgentSetupView, parseChecklistReport } from './panelView.js';
import { NO_MANIFEST_DETAIL } from './compute.js';
import type { ChecklistItem } from './types.js';

const item = (over: Partial<ChecklistItem> = {}): ChecklistItem => ({
  code: 'c1', section: 'general', title: 'T', required: true, status: 'todo', tool: 'set-general', detail: 'd', ...over,
});
const run = (items: ChecklistItem[]) => buildAgentSetupView({ items, error: null, checking: false, updatedLabel: '10:00' });

describe('parseChecklistReport', () => {
  it('reads the items of a JSON report', () => {
    const out = parseChecklistReport(JSON.stringify({ ok: false, items: [item()] }));
    expect(out).toEqual([item()]);
  });
  it('defaults the optional fields', () => {
    const out = parseChecklistReport(JSON.stringify({ items: [{ code: 'a', title: 'A', required: false, status: 'done' }] }));
    expect(out[0]).toMatchObject({ section: 'general', tool: '', detail: '' });
  });
  it('rejects text that is not JSON', () => {
    expect(() => parseChecklistReport('oops')).toThrow('setup checklist printed no JSON report');
  });
  it('rejects a report with no items array', () => {
    expect(() => parseChecklistReport('{}')).toThrow('setup checklist report has no items');
    expect(() => parseChecklistReport('null')).toThrow('setup checklist report has no items');
    expect(() => parseChecklistReport('[]')).toThrow('setup checklist report has no items');
  });
  it.each([
    ['not an object', 'x'],
    ['no code', { title: 'a', required: true, status: 'todo' }],
    ['no title', { code: 'a', required: true, status: 'todo' }],
    ['required not boolean', { code: 'a', title: 'a', required: 'yes', status: 'todo' }],
    ['unknown status', { code: 'a', title: 'a', required: true, status: 'weird' }],
    ['status missing', { code: 'a', title: 'a', required: true }],
  ])('rejects a malformed item: %s', (_n, bad) => {
    expect(() => parseChecklistReport(JSON.stringify({ items: [bad] }))).toThrow('malformed item');
  });
});

describe('buildAgentSetupView', () => {
  it('maps a mixed report to rows and a summary', () => {
    const v = run([
      item({ code: 'a', status: 'done', detail: 'fine' }),
      item({ code: 'b', status: 'todo', detail: 'no gates' }),
      item({ code: 'c', status: 'skipped', required: false }),
      item({ code: 'd', status: 'todo', required: false, detail: 'x' }),
    ]);
    expect(v.rows.map((r) => [r.code, r.status, r.detail])).toEqual([
      ['a', 'done', null], ['b', 'open', 'no gates'], ['c', 'skipped', null], ['d', 'open', 'x'],
    ]);
    expect(v.summary).toEqual({ done: 1, total: 4, skipped: 1, requiredOpen: 1 });
    expect(v.allRequiredDone).toBe(false);
    expect(v.noManifest).toBeNull();
    expect(v.updatedLabel).toBe('10:00');
  });

  it('(a) shows the missing-manifest detail once and keeps nine open rows without detail', () => {
    const detail = `${NO_MANIFEST_DETAIL} (boom)`;
    const v = run(Array.from({ length: 9 }, (_, i) => item({ code: `c${i}`, detail })));
    expect(v.noManifest).toBe(detail);
    expect(v.rows).toHaveLength(9);
    expect(v.rows.every((r) => r.status === 'open' && r.detail === null)).toBe(true);
    expect(v.summary?.requiredOpen).toBe(9);
    expect(v.allRequiredDone).toBe(false);
  });

  it('does not treat a partial missing-manifest match as state (a)', () => {
    const v = run([item({ detail: NO_MANIFEST_DETAIL }), item({ code: 'x', status: 'done' })]);
    expect(v.noManifest).toBeNull();
  });

  it('(b) keeps the old rows while a new run is in flight', () => {
    const v = buildAgentSetupView({ items: [item()], error: null, checking: true, updatedLabel: '09:00' });
    expect(v.checking).toBe(true);
    expect(v.rows).toHaveLength(1);
  });

  it('(b) before the first run: no rows, no summary, checking', () => {
    const v = buildAgentSetupView({ items: undefined, error: null, checking: true, updatedLabel: null });
    expect(v).toMatchObject({ rows: [], summary: null, checking: true, allRequiredDone: false, noManifest: null });
  });

  it('(c) carries the error and never reports done', () => {
    const v = buildAgentSetupView({ items: [item({ status: 'done' })], error: 'timed out', checking: false, updatedLabel: null });
    expect(v.error).toBe('timed out');
    expect(v.allRequiredDone).toBe(false);
  });

  it('(d) is done when only optional items stay open', () => {
    const v = run([item({ status: 'done' }), item({ code: 'o', required: false, status: 'todo' })]);
    expect(v.allRequiredDone).toBe(true);
    expect(v.summary?.requiredOpen).toBe(0);
  });
});
