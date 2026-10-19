import { describe, expect, it, vi } from 'vitest';
import { createMarkerFlow, type MarkerFlowDeps, type MarkerOutcome } from './markerFlow.js';
import type { MarkerReply } from './markerReply.js';
import type { MarkerStage } from '../markerStage.js';

function setup(outcomes: MarkerOutcome[], over: Partial<MarkerFlowDeps> = {}) {
  let saved: MarkerStage | undefined;
  const replies: Array<[string, MarkerReply]> = [];
  const reports: Array<{ stage: string; reason: string; diverged: boolean }> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const queue = [...outcomes];
  const run = vi.fn(async () => queue.shift() ?? { code: 0, stderr: '' });
  let stage: string | null = 'impl';
  const flow = createMarkerFlow({
    runMarker: run,
    reply: async (seq, r) => { replies.push([seq, r]); },
    pending: { load: async () => saved, save: async (s) => { saved = s; }, clear: async () => { saved = undefined; } },
    currentStage: () => stage,
    report: (f) => reports.push(f),
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    backoffMs: [10, 20],
    ...over,
  });
  return { flow, run, replies, reports, timers, get saved() { return saved; }, setStage: (s: string | null) => { stage = s; } };
}

const fire = async (timer: { fn: () => void }, flow: { idle(): Promise<void> }): Promise<void> => {
  timer.fn();
  await new Promise((r) => setImmediate(r));
  await flow.idle();
};

describe('createMarkerFlow', () => {
  it('replies ok and keeps nothing pending after a pass', async () => {
    const t = setup([{ code: 0, stderr: '' }]);
    await t.flow.handle('impl', 'a1');
    expect(t.replies).toEqual([['a1', { v: 1, stage: 'impl', ok: true, retrying: false, reason: '' }]]);
    expect(t.saved).toBeUndefined();
    expect(t.reports).toEqual([]);
  });
  it('a permanent refusal is replied, reported, never retried', async () => {
    const t = setup([{ code: 1, stderr: 'karst: cannot mark this stage done: no repository has changes' }]);
    await t.flow.handle('impl', 'a1');
    expect(t.replies[0]![1]).toMatchObject({ ok: false, retrying: false, reason: expect.stringContaining('no repository has changes') });
    expect(t.reports).toHaveLength(1);
    expect(t.saved).toBeUndefined();
    expect(t.timers).toHaveLength(0);
  });
  it('a transient failure is persisted, replied as retrying, and scheduled with backoff', async () => {
    const t = setup([{ code: 1, stderr: 'sync failed', transient: true }]);
    await t.flow.handle('impl', 'a1');
    expect(t.replies[0]![1]).toMatchObject({ ok: false, retrying: true });
    expect(t.saved).toBe('impl');
    expect(t.timers.map((x) => x.ms)).toEqual([10]);
    expect(t.reports).toHaveLength(1);
  });
  it('the backoff timer retries and a pass clears the pending marker', async () => {
    const t = setup([{ code: 1, stderr: 'x', transient: true }, { code: 0, stderr: '' }]);
    await t.flow.handle('impl', 'a1');
    await fire(t.timers[0]!, t.flow);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(t.saved).toBeUndefined();
    expect(t.timers).toHaveLength(1);
  });
  it('a repeated transient failure walks the backoff list and stays at its last step', async () => {
    const t = setup([{ code: 1, stderr: 'x', transient: true }, { code: 1, stderr: 'x', transient: true }, { code: 1, stderr: 'x', transient: true }]);
    await t.flow.handle('impl', 'a1');
    await fire(t.timers[0]!, t.flow);
    await fire(t.timers[1]!, t.flow);
    expect(t.timers.map((x) => x.ms)).toEqual([10, 20, 20]);
  });
  it('retryPending runs the persisted marker (boot sweep) and clears it once the stage advanced', async () => {
    const t = setup([{ code: 1, stderr: 'x', transient: true }]);
    await t.flow.handle('impl', 'a1');
    t.setStage('uat');
    await t.flow.retryPending();
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.saved).toBeUndefined();
  });
  it('retryPending with nothing persisted does nothing', async () => {
    const t = setup([]);
    await t.flow.retryPending();
    expect(t.run).not.toHaveBeenCalled();
  });
  it('a diverged branch is reported as a blocker and not retried', async () => {
    const t = setup([{ code: 1, stderr: 'not a fast-forward', diverged: true }]);
    await t.flow.handle('impl', 'a1');
    expect(t.reports[0]).toMatchObject({ diverged: true });
    expect(t.saved).toBeUndefined();
    expect(t.timers).toHaveLength(0);
  });
  it('a marker for a stage that already advanced is acknowledged without running', async () => {
    const t = setup([]);
    t.setStage('uat');
    await t.flow.handle('impl', 'a1');
    expect(t.run).not.toHaveBeenCalled();
    expect(t.replies[0]![1]).toMatchObject({ ok: true });
  });
  it('runs markers one at a time', async () => {
    let active = 0; let peak = 0;
    const t = setup([], { runMarker: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return { code: 0, stderr: '' }; } });
    await Promise.all([t.flow.handle('impl', 'a'), t.flow.handle('impl', 'b')]);
    expect(peak).toBe(1);
  });
  it('stop cancels the pending timer', async () => {
    const t = setup([{ code: 1, stderr: 'x', transient: true }]);
    await t.flow.handle('impl', 'a1');
    t.flow.stop();
    expect(t.timers[0]!.cancelled).toBe(true);
  });
  it('a failing reply write never breaks the flow', async () => {
    const t = setup([{ code: 0, stderr: '' }], { reply: async () => { throw new Error('disk'); } });
    await expect(t.flow.handle('impl', 'a1')).resolves.toBeUndefined();
  });
});
