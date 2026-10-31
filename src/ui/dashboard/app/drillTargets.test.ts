import { describe, expect, it } from 'vitest';
import type { DashboardState } from '../state.js';
import { consoleStreams, pillOf, viewLabel, viewPills } from './drillTargets.js';
import { DASHBOARD } from './overlayStack.js';

const proc = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id, status: 'pass', console: true, ...over });
const insideViews = {
  uat: { stageKey: 'uat', title: 'UAT', console: true, processes: [proc('gates', { console: false, status: 'fail' }), proc('tester', { label: 'Tester', time: '12:01', statusLabel: 'Completed' })] },
  review: { stageKey: 'review', title: 'Review', processes: [proc('reviewer', { console: false })] },
};
const st = (over: Record<string, unknown> = {}): DashboardState => ({ artifacts: [], servers: [], insideViews, envOverrides: null, ...over }) as unknown as DashboardState;

describe('consoleStreams', () => {
  it('lists the stage console and each console-capable process, with a status word and age', () => {
    expect(consoleStreams(insideViews as never)).toEqual([
      { stage: 'uat', processId: null, label: 'UAT', status: 'fail', word: 'Failed', age: '' },
      { stage: 'uat', processId: 'tester', label: 'UAT · Tester', status: 'pass', word: 'Completed', age: '12:01' },
    ]);
  });
  it('is empty without views', () => expect(consoleStreams(undefined)).toEqual([]));
});

describe('viewPills', () => {
  it('hides a pill with nothing behind it', () => {
    expect(viewPills(st({ insideViews: {} })).map((p) => p.key)).toEqual(['dashboard']);
  });
  it('shows every pill with its count when all targets exist', () => {
    const pills = viewPills(st({ artifacts: [{ id: 'a' }], servers: [{}, {}], envOverrides: { services: [], values: {} } }));
    expect(pills.map((p) => [p.key, p.count])).toEqual([['dashboard', null], ['artifacts', 1], ['console', 2], ['logs', 2], ['env', null]]);
  });
  it('hides Env variables without servers', () => {
    expect(viewPills(st({ envOverrides: { services: [], values: {} } })).some((p) => p.key === 'env')).toBe(false);
  });
});

describe('pillOf / viewLabel', () => {
  it('maps each surface to its pill', () => {
    expect(pillOf(DASHBOARD)).toBe('dashboard');
    expect(pillOf({ ...DASHBOARD, art: 'index' })).toBe('artifacts');
    expect(pillOf({ ...DASHBOARD, console: { stage: 'uat', processId: null } })).toBe('console');
    expect(pillOf({ ...DASHBOARD, logs: true })).toBe('logs');
    expect(pillOf({ ...DASHBOARD, env: true })).toBe('env');
  });
  it('names a detail by its artifact title, falling back when it is gone', () => {
    const view = { ...DASHBOARD, art: { id: 'plan', from: 'index' as const } };
    expect(viewLabel(view, st({ artifacts: [{ id: 'plan', title: 'Plan' }] }))).toBe('Plan');
    expect(viewLabel(view, null)).toBe('Artifact');
    expect(viewLabel(DASHBOARD, null)).toBe('Dashboard');
  });
});
