import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { recordGateRun, HOST_RERUN_SOURCE } from '../store/gateRuns.js';
import { hasUatGatePass } from '../store/uatGatePasses.js';
import { setStage } from '../store/stages.js';
import type { Manifest } from '../manifest/types.js';
import type { GitRunner } from '../integrations/git.js';
import { recordHostRerunPass, type HostRerunPassDeps } from './hostRerunPass.js';

const BATCH_AT = '2026-01-01T00:00:00Z';
const RERUN_AT = '2026-01-01T01:00:00Z';
const withBaseline = { uat: { baselineReview: { paths: ['shots'] } } } as unknown as Manifest;
const withoutBaseline = { uat: {} } as unknown as Manifest;
const gate = (name: string, exitCode: number | null, over: Record<string, unknown> = {}) => ({
  gateName: name, exitCode, repo: 'web', command: 'npm', args: ['run', name], ...over,
});

describe('recordHostRerunPass', () => {
  let store: Store;
  let ticketId: number;
  let fingerprint: ReturnType<typeof vi.fn>;
  const deps = (manifest: Manifest | undefined = withBaseline): HostRerunPassDeps => ({
    manifest: () => manifest,
    git: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as unknown as GitRunner,
    fingerprint: fingerprint as never,
    now: () => RERUN_AT,
  });
  const batch = (gates: ReturnType<typeof gate>[]) =>
    recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 2, runAt: BATCH_AT, gates });
  const rerun = (gates: ReturnType<typeof gate>[]) =>
    recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 2, runAt: RERUN_AT, source: HOST_RERUN_SOURCE, gates });

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', attempt: 2 });
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(ticketId, 'web', '/wt/web', 'b');
    fingerprint = vi.fn(async () => 'fp-1');
  });

  it('records the pass at the attempt UAT reads when every gate of the batch has a pass', async () => {
    batch([gate('lint', 0), gate('visual', 1)]);
    rerun([gate('visual', 0)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('recorded');
    expect(hasUatGatePass(store, ticketId, 2, 'fp-1')).toBe(true);
    expect(fingerprint.mock.calls[0]![3]).toEqual([{ repo: 'web', path: '/wt/web' }]);
  });

  it('does not match a pass at another fingerprint', async () => {
    batch([gate('visual', 1)]);
    rerun([gate('visual', 0)]);
    await recordHostRerunPass(store, ticketId, 'uat', deps());
    expect(hasUatGatePass(store, ticketId, 2, 'fp-2')).toBe(false);
  });

  it('records nothing when a gate of the batch was skipped', async () => {
    batch([gate('visual', 1), gate('docs', null, { skipped: true })]);
    rerun([gate('visual', 0)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('gate-not-passed');
    expect(hasUatGatePass(store, ticketId, 2, 'fp-1')).toBe(false);
  });

  it('records nothing when a gate was not run after an early stop', async () => {
    batch([gate('unit', 1), gate('visual', null)]);
    rerun([gate('unit', 0)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('gate-not-passed');
  });

  it('records nothing when the batch regenerate failed: the later gates of that repo never ran and have no row', async () => {
    batch([gate('regenerate (web)', 1, { command: 'regenerate (web)', args: [] })]);
    rerun([gate('regenerate (web)', 0, { command: 'regenerate (web)', args: [] })]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('gate-not-passed');
    expect(hasUatGatePass(store, ticketId, 2, 'fp-1')).toBe(false);
  });

  it('records the pass when the batch regenerate passed and a later gate failed', async () => {
    batch([gate('regenerate (web)', 0, { command: 'regenerate (web)', args: [] }), gate('visual', 1)]);
    rerun([gate('visual', 0)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('recorded');
  });

  it('records nothing when a failed gate has no passing re-run row (cannotRerun)', async () => {
    batch([gate('lint', 0), gate('visual', 1)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('gate-not-passed');
  });

  it.each([
    ['gate name', { gateName: 'other' }],
    ['repo', { repo: 'api' }],
    ['command', { command: 'pnpm' }],
    ['args', { args: ['run', 'else'] }],
  ])('does not take a passed re-run row of another %s as the pass of the failed gate', async (_label, over) => {
    batch([gate('visual', 1)]);
    rerun([gate('visual', 0, over)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('gate-not-passed');
  });

  it('does not take a passed re-run row from before the batch', async () => {
    recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: '2025-12-31T00:00:00Z', source: HOST_RERUN_SOURCE, gates: [gate('visual', 0)] });
    batch([gate('visual', 1)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('gate-not-passed');
  });

  it('records nothing when the re-run row failed', async () => {
    batch([gate('visual', 1)]);
    rerun([gate('visual', 1)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('gate-not-passed');
  });

  it('records nothing when baseline review is off, and computes no fingerprint', async () => {
    batch([gate('visual', 1)]);
    rerun([gate('visual', 0)]);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps(withoutBaseline))).toBe('baseline-review-off');
    expect(await recordHostRerunPass(store, ticketId, 'uat', { ...deps(), manifest: () => undefined })).toBe('baseline-review-off');
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it('records nothing when the fingerprint cannot be computed', async () => {
    batch([gate('visual', 1)]);
    rerun([gate('visual', 0)]);
    fingerprint.mockResolvedValue(null);
    expect(await recordHostRerunPass(store, ticketId, 'uat', deps())).toBe('no-fingerprint');
  });

  it('records nothing for a review-stage round', async () => {
    expect(await recordHostRerunPass(store, ticketId, 'review', deps())).toBe('not-uat');
    expect(fingerprint).not.toHaveBeenCalled();
  });
});
