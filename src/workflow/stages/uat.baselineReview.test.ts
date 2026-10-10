import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { recordBaselineDecisions } from '../../store/baselineDecisions.js';
import { manifest, uat as uatConfig } from '../../manifest/fixtures.js';
import { runUat, type UatDeps } from './uat.js';
import type { BaselineEntry } from '../gates/baselineReview.js';

const now = () => '2026-07-30T10:00:00.000Z';

const ENTRY: BaselineEntry = {
  repo: '/web',
  cwd: '/wt/web',
  path: 'tests/visual/__baselines__/settings.png',
  status: 'modified',
  newSha256: 'sha-1',
  mergeBase: 'abc',
};

function deps(over: Partial<UatDeps> = {}): UatDeps {
  return {
    now,
    git: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    planTargets: async () => ({
      kind: 'targets',
      targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }],
      unmapped: [],
    }),
    probe: () => ({ kind: 'ok', scripts: { test: 'vitest' } }),
    checkDeps: async () => ({ ok: true }),
    runGates: async (gates, _cwd, opts) => {
      const results = gates.map((g, i) => {
        opts?.onGateComplete?.(g.name, 0, now(), now(), i);
        return { name: g.name, exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() };
      });
      return { kind: 'ran', results };
    },
    detectBaselines: async () => [ENTRY],
    ...over,
  };
}

const withKnob = () =>
  manifest(
    {},
    { uat: uatConfig({ baselineReview: { paths: ['tests/visual/__baselines__/**'] } }) },
  );

describe('runUat — baseline review (@arch:BASELINE-REVIEW)', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-uat-br-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  const run = (d: UatDeps, m = withKnob()) =>
    runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir, manifest: m }, d);

  it('passing gates + an unapproved changed baseline → parked baseline-review', async () => {
    const res = await run(deps());
    expect(res).toEqual({
      kind: 'blocked',
      blocker: 'baseline-review',
      reason: '1 visual baseline(s) changed — review in the UAT report',
    });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(stageBlock(store, id, 'uat')?.kind).toBe('baseline-review');
  });

  it('a failing gate verdict wins: the ticket goes to fix, not baseline review', async () => {
    const res = await run(
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
  });

  it('proceeds once the user approved the current sha', async () => {
    recordBaselineDecisions(
      store,
      id,
      [{ repo: ENTRY.repo, path: ENTRY.path, sha256: 'sha-1', decision: 'approved', reason: null }],
      now(),
    );
    expect(await run(deps())).toEqual({ kind: 'advanced', next: 'review' });
  });

  it('asks again when the agent re-recorded the file after the approval', async () => {
    recordBaselineDecisions(
      store,
      id,
      [{ repo: ENTRY.repo, path: ENTRY.path, sha256: 'old-sha', decision: 'approved', reason: null }],
      now(),
    );
    expect(await run(deps())).toMatchObject({ kind: 'blocked', blocker: 'baseline-review' });
  });

  it('is off — detection never runs — without the manifest knob', async () => {
    let called = false;
    const res = await run(
      deps({ detectBaselines: async () => ((called = true), [ENTRY]) }),
      manifest({}),
    );
    expect(called).toBe(false);
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
  });

  it('no changed baselines → unchanged behaviour', async () => {
    expect(await run(deps({ detectBaselines: async () => [] }))).toEqual({
      kind: 'advanced',
      next: 'review',
    });
  });

  it('parks capability-missing when git cannot answer — never reads as "unchanged"', async () => {
    const res = await run(
      deps({
        detectBaselines: async () => {
          throw new Error('baseline review: no merge-base between develop and HEAD');
        },
      }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
  });
});
