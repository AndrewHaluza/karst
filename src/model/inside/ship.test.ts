import { describe, it, expect } from 'vitest';
import type { ShipCommit, ShipEvidence, ShipRepoEvidence, ShipRepoStepEvidence, ShipRun, ShipStep } from '../../store/shipRuns.js';
import type { MergeCheckRow } from '../../store/mergeChecks.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import { shipProcesses, type ShipProcessesInput } from './ship.js';
import type { InsideEvidenceTarget, ShipPrView } from './types.js';
import type { EvidenceRow, InsideProcessView } from './types.js';

const NOW = '2026-07-20T12:30:00.000Z';

function cell(stageKey: StageKey, status: StageStatus, extra: Partial<StepperCell> = {}): StepperCell {
  return { stageKey, status, ...extra };
}

const shipRun: ShipRun = {
  id: 1,
  ticketId: 1,
  attempt: 1,
  status: 'passed',
  startedAt: '2026-07-20T12:00:00.000Z',
  endedAt: '2026-07-20T12:03:00.000Z',
};

let nextId = 1;
function step(stepName: ShipStep, over: Partial<ShipRepoStepEvidence> = {}): ShipRepoStepEvidence {
  return {
    id: nextId++,
    shipRunId: 1,
    repo: '/web',
    step: stepName,
    status: 'passed',
    detail: '',
    prNumber: null,
    prStatus: null,
    existedBeforeShip: null,
    processRunId: null,
    operationIntentId: null,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:01:00.000Z',
    hasIntent: true,
    number: null,
    ...over,
  };
}

let nextCommit = 1;
function shipCommit(origin: 'before-ship' | 'created-by-ship', over: Partial<ShipCommit> = {}): ShipCommit {
  return {
    id: nextCommit++,
    shipRunId: 1,
    repo: '/web',
    sha: 'abc123',
    message: 'm',
    origin,
    ...over,
  };
}

function repoEvidence(repo: string, over: Partial<ShipRepoEvidence> = {}): ShipRepoEvidence {
  return { steps: {}, commits: [], intents: {}, ...over };
}

function evidence(over: Partial<ShipEvidence> = {}): ShipEvidence {
  return { run: shipRun, repos: {}, ...over };
}

function pr(repo: string, over: Partial<ShipPrView> = {}): ShipPrView {
  return { repo, number: null, status: null, headRef: null, baseRef: null, mergedAt: null, ...over };
}

function check(repo: string, over: Partial<MergeCheckRow> = {}): MergeCheckRow {
  return {
    ticketId: 1,
    repo,
    state: 'clean',
    files: [],
    reason: null,
    headSha: 'aaa1111',
    baseSha: 'bbb2222',
    baseRef: 'main',
    checkedAt: NOW,
    ...over,
  };
}

function shipInput(extra: Partial<ShipProcessesInput> = {}): ShipProcessesInput {
  return {
    cell: cell('ship', 'passed', {
      startedAt: '2026-07-20T12:00:00.000Z',
      endedAt: '2026-07-20T12:03:00.000Z',
    }),
    evidence: evidence(),
    prs: [],
    mergeChecks: [],
    now: NOW,
    ...extra,
  };
}

function rowsOf(process: InsideProcessView): readonly EvidenceRow[] {
  const evidenceKind = process.evidence;
  if (evidenceKind?.kind === 'rows') return evidenceKind.rows;
  if (evidenceKind?.kind === 'commits') return evidenceKind.rows;
  if (evidenceKind?.kind === 'prs') return evidenceKind.rows;
  throw new Error(`expected rows-bearing evidence, got ${process.evidence?.kind ?? 'none'}`);
}

describe('shipProcesses', () => {
  it('emits commit, push, pr, merge in registry order', () => {
    const views = shipProcesses(shipInput());
    expect(views.map((p) => p.id)).toEqual(['commit', 'push', 'pr', 'merge']);
  });

  it('distinguishes ship-created commits from pre-existing ones per repo', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              commits: [
                shipCommit('created-by-ship'),
                shipCommit('created-by-ship'),
                shipCommit('before-ship'),
              ],
            }),
          },
        }),
      }),
    );
    const commit = views[0]!;
    const evidenceView = commit.evidence as { kind: 'commits'; rows: readonly EvidenceRow[]; total?: number };
    expect(evidenceView.total).toBe(2);
    expect(evidenceView.rows).toHaveLength(1);
    expect(evidenceView.rows[0]!.detail).toContain('2 created');
    expect(evidenceView.rows[0]!.detail).toContain('1 before');
  });

  it('reads a nothing-to-commit step as a note, never a pass or fail', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { commit: step('commit', { status: 'note', detail: 'nothing to commit' }) },
            }),
          },
        }),
      }),
    );
    expect(rowsOf(views[0]!)[0]!.status).toBe('note');
    expect(rowsOf(views[0]!)[0]!.detail).toContain('nothing to commit');
  });

  it('ships the created-commit total as the commit process-row aggregate (B4)', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              commits: [shipCommit('created-by-ship'), shipCommit('created-by-ship'), shipCommit('before-ship')],
            }),
            '/api': repoEvidence('/api', {
              commits: [shipCommit('created-by-ship', { repo: '/api' })],
            }),
          },
        }),
      }),
    );
    // Host-computed (B4): the webview concatenates nothing; total is the
    // created-by-ship count, pre-existing commits are not delivery.
    expect(views[0]!.aggregate).toBe('3 commits');
  });

  it('omits the commit aggregate when nothing was created by ship (B4)', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: { '/web': repoEvidence('/web', { commits: [shipCommit('before-ship')] }) },
        }),
      }),
    );
    expect(views[0]!.aggregate).toBeUndefined();
  });

  it('aggregates current PR open/merged counts on the pr process row (B4)', () => {
    const views = shipProcesses(
      shipInput({
        prs: [
          pr('/web', { number: 1, status: 'open' }),
          pr('/api', { number: 2, status: 'merged', mergedAt: NOW }),
          pr('/worker', { number: 3, status: 'open' }),
        ],
      }),
    );
    const prProcess = views[2]!;
    expect(prProcess.aggregate).toBe('1 merged · 2 open');
  });

  it('omits the pr aggregate when no current PR exists (B4)', () => {
    const views = shipProcesses(shipInput({ prs: [] }));
    expect(views[2]!.aggregate).toBeUndefined();
  });

  it('states a conflicted merge in the handoff §11 copy on the process row (B9)', () => {
    const views = shipProcesses(
      shipInput({
        prs: [pr('/web', { number: 4, status: 'open' })],
        mergeChecks: [check('/web', { state: 'conflicted', files: ['a.ts'], reason: 'both sides edit' })],
      }),
    );
    const merge = views[3]!;
    expect(merge.status).toBe('wait'); // a conflict is a wait, never a fail
    expect(merge.detail).toBe(
      'Ship is waiting: resolve the merge conflict before the ticket can be done.',
    );
    // The per-repo row keeps its factual reading; the sentence is the summary.
    expect(rowsOf(merge)[0]!.detail).toContain('conflicted');
  });

  it('reads a note pr step as the no-changes copy (B9)', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { pr: step('pr', { status: 'note', detail: 'no PR needed — no changes from develop' }) },
            }),
          },
        }),
      }),
    );
    const row = rowsOf(views[2]!)[0]!;
    expect(row.status).toBe('note'); // no changes is not a failure
    expect(row.detail).toBe(
      'No PR was created because this repository had no changes',
    );
  });

  it('names the bounded continuation with the exact reveal count (B9)', () => {
    // handoff §10: a continuation says exactly what it reveals. The REDUCER
    // computes the label on the target; the host's attach closure carries it
    // into the shipped action (state.ts, pinned by its own suite).
    const repos: Record<string, ShipRepoEvidence> = {};
    for (let i = 0; i < 10; i += 1) {
      repos[`/repo-${i}`] = repoEvidence(`/repo-${i}`, {
        steps: { push: step('push', { repo: `/repo-${i}` }) },
      });
    }
    let label: string | undefined;
    const views = shipProcesses(
      shipInput({
        evidence: evidence({ repos }),
        attach: (target) => {
          if (target.kind === 'open-bounded-evidence') label = target.label;
          return { actionId: 'snapshot-1:action-0', kind: target.kind };
        },
      }),
    );
    const rows = rowsOf(views[1]!); // push — bounded at 6
    expect(rows.at(-1)!.action).toMatchObject({ kind: 'open-bounded-evidence' });
    expect(label).toBe('Show 4 more');
  });

  it('aggregates at 20 repos: bounded rows and the remainder named', () => {    const repos: Record<string, ShipRepoEvidence> = {};
    for (let i = 0; i < 20; i += 1) {
      repos[`/repo-${i}`] = repoEvidence(`/repo-${i}`, {
        steps: { push: step('push', { repo: `/repo-${i}` }) },
      });
    }
    const views = shipProcesses(shipInput({ evidence: evidence({ repos }) }));
    // The top-level ledger is FOUR process rows whatever the repo count — the
    // scale invariant the redesign names (§10): repos unfold inside evidence,
    // never as rows.
    expect(views).toHaveLength(4);
    const push = views[1]!;
    const rows = rowsOf(push);
    expect(rows).toHaveLength(7);
    expect(rows.at(-1)).toMatchObject({ status: 'note', label: 'more' });
    expect(rows.at(-1)!.detail).toContain('14');
  });

  it('preserves a push failure verbatim as a failed row', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { push: step('push', { status: 'failed', detail: 'push rejected: non-fast-forward' }) },
            }),
          },
        }),
      }),
    );
    const push = views[1]!;
    expect(push.status).toBe('fail');
    expect(rowsOf(push)[0]!.detail).toContain('non-fast-forward');
  });

  it('names an adopted PR as adopted and a created PR as created, with its number', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: {
                pr: step('pr', { existedBeforeShip: true, number: 40 }),
              },
            }),
            '/api': repoEvidence('/api', {
              steps: {
                pr: step('pr', { repo: '/api', existedBeforeShip: false, number: 41 }),
              },
            }),
          },
        }),
      }),
    );
    const rows = rowsOf(views[2]!);
    const web = rows.find((r) => r.label === '/web')!;
    const api = rows.find((r) => r.label === '/api')!;
    expect(web.detail).toContain('adopted');
    expect(web.detail).toContain('#40');
    expect(api.detail).toContain('created');
    expect(api.detail).toContain('#41');
  });

  it('says the number is pending when a created PR has none recorded yet', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { pr: step('pr', { existedBeforeShip: false, number: null }) },
            }),
          },
        }),
      }),
    );
    const rows = rowsOf(views[2]!);
    expect(rows[0]!.detail).toContain('created');
    expect(rows[0]!.detail).toContain('pending');
  });

  it('reads the merge process from CURRENT PRs: merged passes, open waits', () => {
    const views = shipProcesses(
      shipInput({
        prs: [
          pr('/web', { number: 40, status: 'merged', mergedAt: NOW }),
          pr('/api', { number: 41, status: 'open' }),
        ],
      }),
    );
    const merge = views[3]!;
    expect(merge.status).toBe('wait');
    const rows = rowsOf(merge);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'pass', label: 'merged' });
    expect(rows[1]).toMatchObject({ status: 'wait', label: 'open' });
    expect(rows[1]!.detail).toContain('not merged yet');
  });

  it('reads a draft PR as a wait, not a pass', () => {
    const views = shipProcesses(
      shipInput({ prs: [pr('/web', { number: 40, status: 'draft' })] }),
    );
    const rows = rowsOf(views[3]!);
    expect(rows[0]).toMatchObject({ status: 'wait', label: 'draft' });
  });

  it('reads a merge conflict as a WAIT naming the files — never a failed verdict', () => {
    const views = shipProcesses(
      shipInput({
        prs: [pr('/web', { number: 40, status: 'open' })],
        mergeChecks: [check('/web', { state: 'conflicted', files: ['a.ts', 'b.ts'] })],
      }),
    );
    const merge = views[3]!;
    expect(merge.status).toBe('wait');
    const rows = rowsOf(merge);
    expect(rows[0]!.status).toBe('wait');
    expect(rows[0]!.label).toBe('conflict');
    expect(rows[0]!.detail).toContain('a.ts');
    expect(rows[0]!.detail).not.toContain('failed');
  });

  it('lets the CURRENT PR answer for a repo that was re-shipped after a merge', () => {
    const views = shipProcesses(
      shipInput({
        prs: [
          pr('/web', { number: 40, status: 'merged', mergedAt: '2026-07-19T00:00:00.000Z' }),
          pr('/web', { number: 42, status: 'open' }),
        ],
      }),
    );
    const rows = rowsOf(views[3]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain('#42');
    expect(rows[0]!.detail).not.toContain('#40');
  });

  it('says nothing to merge once ship entered but no PR exists', () => {
    const views = shipProcesses(shipInput({}));
    const merge = views[3]!;
    expect(merge.status).toBe('note');
    expect(merge.detail).toContain('nothing to merge');
  });

  it('renders absence honestly when no ship evidence was ever recorded', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({ run: undefined }),
        cell: cell('ship', 'passed', { startedAt: NOW, endedAt: NOW }),
      }),
    );
    // The evidence-backed processes (commit, push, pr) state the absence; the
    // merge process answers the live question from current PRs instead.
    for (const process of views.slice(0, 3)) {
      expect(process.status).toBe('note');
      expect(process.detail).toContain('no recorded evidence');
    }
  });

  describe('process aggregation keeps note honest', () => {
    const pushViews = (stepsByRepo: Record<string, Partial<ShipRepoStepEvidence>>) =>
      shipProcesses(
        shipInput({
          evidence: evidence({
            repos: Object.fromEntries(
              Object.entries(stepsByRepo).map(([repo, over]) => [
                repo,
                repoEvidence(repo, { steps: { push: step('push', { repo, ...over }) } }),
              ]),
            ),
          }),
        }),
      );

    it('reads all-note as note, never pass', () => {
      const views = pushViews({ '/web': { status: 'note' }, '/api': { status: 'note' } });
      expect(views[1]!.status).toBe('note');
    });

    it('does not read a pass beside a note as green — the note is absence', () => {
      const views = pushViews({ '/web': { status: 'passed' }, '/api': { status: 'note' } });
      expect(views[1]!.status).not.toBe('pass');
      expect(views[1]!.status).toBe('note');
    });

    it('reads pass-only as pass', () => {
      const views = pushViews({ '/web': { status: 'passed' }, '/api': { status: 'passed' } });
      expect(views[1]!.status).toBe('pass');
    });

    it('keeps a running row ahead of note — run retains precedence', () => {
      const views = pushViews({ '/web': { status: 'running' }, '/api': { status: 'note' } });
      expect(views[1]!.status).toBe('run');
    });

    it('keeps a failed row ahead of a passed one', () => {
      const views = pushViews({ '/web': { status: 'failed' }, '/api': { status: 'passed' } });
      expect(views[1]!.status).toBe('fail');
    });

    it('reads a missing step record as note even beside a passed row', () => {
      const views = shipProcesses(
        shipInput({
          evidence: evidence({
            repos: {
              '/web': repoEvidence('/web', { steps: { push: step('push', { status: 'passed' }) } }),
              '/api': repoEvidence('/api'),
            },
          }),
        }),
      );
      expect(views[1]!.status).toBe('note');
    });

    it('keeps an all-pass process green past the per-repo display bound', () => {
      // The bounded remainder row ("+N more") is a display marker, not a
      // recorded row — it must not turn a fully-passed process into a note.
      const repos: Record<string, ShipRepoEvidence> = {};
      for (let i = 0; i < 10; i += 1) {
        repos[`/repo-${i}`] = repoEvidence(`/repo-${i}`, {
          steps: { push: step('push', { repo: `/repo-${i}` }) },
        });
      }
      const views = shipProcesses(shipInput({ evidence: evidence({ repos }) }));
      expect(views[1]!.status).toBe('pass');
    });
  });

  describe('landing reads only literal merged status', () => {
    it('does not read a merge stamp on an open PR as landed', () => {
      const views = shipProcesses(
        shipInput({ prs: [pr('/web', { number: 40, status: 'open', mergedAt: NOW })] }),
      );
      const merge = views[3]!;
      expect(merge.status).toBe('wait');
      expect(rowsOf(merge)[0]).toMatchObject({ status: 'wait' });
      expect(rowsOf(merge)[0]!.detail).toContain('not merged yet');
    });

    it('does not read a merge stamp on an unknown PR as landed', () => {
      const views = shipProcesses(
        shipInput({ prs: [pr('/web', { number: 40, status: 'unknown', mergedAt: NOW })] }),
      );
      expect(views[3]!.status).toBe('wait');
    });

    it('counts a stamped-but-open PR as open in the pr process evidence', () => {
      const views = shipProcesses(
        shipInput({ prs: [pr('/web', { number: 40, status: 'open', mergedAt: NOW })] }),
      );
      const prView = views[2]!;
      const prsEvidence = prView.evidence as { kind: 'prs'; open: number; merged: number };
      expect(prsEvidence.merged).toBe(0);
      expect(prsEvidence.open).toBe(1);
    });

    it('reads a PR with literal merged status as landed, stamp or no stamp', () => {
      const views = shipProcesses(
        shipInput({ prs: [pr('/web', { number: 40, status: 'merged' })] }),
      );
      const merge = views[3]!;
      expect(merge.status).toBe('pass');
      expect(rowsOf(merge)[0]).toMatchObject({ status: 'pass', label: 'merged' });
    });
  });

  it.each([10, 15, 20])(
    'bounds every repository process and exposes all %i rows through a typed continuation',
    (count) => {
      const repos: Record<string, ShipRepoEvidence> = {};
      const prs: ShipPrView[] = [];
      for (let i = 0; i < count; i += 1) {
        const repo = `/repo-${String(i + 1).padStart(2, '0')}`;
        repos[repo] = repoEvidence(repo, {
          steps: {
            commit: step('commit', { repo }),
            push: step('push', { repo }),
            pr: step('pr', { repo, number: 100 + i }),
          },
          commits: [shipCommit('created-by-ship', { repo, sha: `sha-${i}` })],
        });
        prs.push(pr(repo, { number: 100 + i, status: 'open' }));
      }
      const targets: InsideEvidenceTarget[] = [];
      const views = shipProcesses(
        shipInput({
          evidence: evidence({ repos }),
          prs,
          attach: (target) => {
            targets.push(target);
            return { actionId: `snapshot-1:action-${targets.length}`, kind: target.kind };
          },
        }),
      );

      for (const process of views) {
        const rows = rowsOf(process);
        expect(rows).toHaveLength(7);
        expect(rows.at(-1)).toMatchObject({
          label: 'more',
          detail: `+${count - 6} more`,
          action: { kind: 'open-bounded-evidence' },
        });
      }
      const boundedTargets = targets.filter((target) => target.kind === 'open-bounded-evidence');
      expect(boundedTargets).toHaveLength(4);
      for (const target of boundedTargets) {
        expect(target.kind).toBe('open-bounded-evidence');
        if (target.kind === 'open-bounded-evidence') expect(target.rows).toHaveLength(count);
      }
    },
  );
});
