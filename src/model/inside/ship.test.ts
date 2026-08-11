import { describe, it, expect } from 'vitest';
import type { ShipCommit, ShipEvidence, ShipRepoEvidence, ShipRepoStepEvidence, ShipRun, ShipStep } from '../../store/shipRuns.js';
import type { MergeCheckRow } from '../../store/mergeChecks.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey, StageStatus } from '../types.js';
import { shipProcesses, type ShipProcessesInput } from './ship.js';
import { formatTime, type InsideEvidenceTarget, type ShipPrView } from './types.js';
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
  pid: null,
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

  it('states when each recorded ship step started', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: {
                commit: step('commit', {
                  startedAt: '2026-07-20T12:00:00.000Z',
                  endedAt: '2026-07-20T12:00:30.000Z',
                }),
                push: step('push', {
                  startedAt: '2026-07-20T12:00:30.000Z',
                  endedAt: '2026-07-20T12:01:00.000Z',
                }),
                pr: step('pr', {
                  startedAt: '2026-07-20T12:01:00.000Z',
                  endedAt: '2026-07-20T12:01:10.000Z',
                  number: 5,
                }),
              },
            }),
          },
        }),
        prs: [pr('/web', { number: 5, status: 'open' })],
      }),
    );
    const commit = rowsOf(views[0]!)[0]!;
    const push = rowsOf(views[1]!)[0]!;
    const prRow = rowsOf(views[2]!)[0]!;
    expect(commit.time).toBe(formatTime('2026-07-20T12:00:00.000Z'));
    expect(commit.durationExact).toBe('30.000s');
    expect(push.time).toBe(formatTime('2026-07-20T12:00:30.000Z'));
    expect(push.durationExact).toBe('30.000s');
    expect(prRow.time).toBe(formatTime('2026-07-20T12:01:00.000Z'));
    expect(prRow.durationExact).toBe('10.000s');
    // The merge process reads current PR state, never a recorded step — it
    // has no start to state.
    expect(rowsOf(views[3]!)[0]!.time).toBeUndefined();
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

  it('carries the created-commit total on the evidence, never as a row chip (fu2)', () => {
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
    // The count rides the EVIDENCE, which renders it per repository. The row
    // itself carries no chip: its description already says how many
    // repositories are commit-ready and how many the ship created, and the
    // chip repeated that sentence in a terser voice (869egdr2u-fu2).
    const commit = views[0]!;
    expect(commit.aggregate).toBeUndefined();
    expect(commit.detail).toBe('2 repositories commit-ready · 2 created in Ship');
    expect(commit.evidence).toMatchObject({ kind: 'commits', total: 3 });
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

  it('keeps the landing counts on the pr evidence, never as a row chip (fu2)', () => {
    const views = shipProcesses(
      shipInput({
        prs: [
          pr('/web', { number: 1, status: 'open' }),
          pr('/api', { number: 2, status: 'merged', mergedAt: NOW }),
          pr('/worker', { number: 3, status: 'open' }),
        ],
      }),
    );
    // The Merge process directly beneath states the landing count; a second
    // "1 merged" chip on the PR row said it twice (869egdr2u-fu2). The counts
    // still ride the evidence, where the bodies read them.
    const prProcess = views[2]!;
    expect(prProcess.aggregate).toBeUndefined();
    expect(prProcess.evidence).toMatchObject({ kind: 'prs', merged: 1, open: 2 });
    expect(views[3]!.detail).toBe('1/3 merged');
  });

  it('omits the pr aggregate when no current PR exists (B4)', () => {
    const views = shipProcesses(shipInput({ prs: [] }));
    expect(views[2]!.aggregate).toBeUndefined();
    expect(views[2]!.evidence).toMatchObject({ kind: 'prs', merged: 0, open: 0 });
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
    // The row describes every state — the merged count, like Push's
    // "1/2 pushed" (869egdr2u-fu1: the row had no description at all).
    expect(merge.detail).toBe('1/2 merged');
    // The expanded rows name the repo, the PR number with its state chip, and
    // the timestamp of the fact the row reads.
    expect(rows[0]).toMatchObject({
      status: 'pass',
      label: '/web · merged',
      detail: '#40',
      prState: 'merged',
    });
    expect(rows[0]!.time).toBe(formatTime(NOW));
    expect(rows[1]).toMatchObject({
      status: 'wait',
      label: '/api · open',
      detail: '#41 · not merged yet',
      prState: 'open',
    });
  });

  it('describes an all-merged merge row with the full count', () => {
    const views = shipProcesses(
      shipInput({
        prs: [
          pr('/web', { number: 40, status: 'merged', mergedAt: NOW }),
          pr('/api', { number: 41, status: 'merged', mergedAt: NOW }),
        ],
      }),
    );
    const merge = views[3]!;
    expect(merge.status).toBe('pass');
    expect(merge.detail).toBe('2/2 merged');
  });

  it('never counts a PR that is not literally merged as delivered', () => {
    const views = shipProcesses(
      shipInput({
        prs: [
          pr('/web', { number: 40, status: 'unknown' }),
          pr('/api', { number: 41, status: 'open' }),
        ],
      }),
    );
    const merge = views[3]!;
    expect(merge.status).toBe('wait');
    expect(merge.detail).toBe('0/2 merged');
  });

  it('reads a draft PR as a wait, not a pass', () => {
    const views = shipProcesses(
      shipInput({ prs: [pr('/web', { number: 40, status: 'draft' })] }),
    );
    const rows = rowsOf(views[3]!);
    expect(rows[0]).toMatchObject({ status: 'wait', label: '/web · draft' });
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
    expect(rows[0]!.label).toBe('/web · conflict');
    expect(rows[0]!.detail).toContain('a.ts');
    expect(rows[0]!.detail).not.toContain('failed');
    // The conflict row dates from the last merge check.
    expect(rows[0]!.time).toBe(formatTime(NOW));
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
      expect(rowsOf(merge)[0]).toMatchObject({ status: 'pass', label: '/web · merged' });
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
      // Four processes each bound their flat rows, and the two rich bodies
      // (the commit grid, the PR branches) bound their blocks over the SAME
      // recorded rows — six continuations, every one opening all `count` rows.
      expect(boundedTargets).toHaveLength(6);
      for (const target of boundedTargets) {
        expect(target.kind).toBe('open-bounded-evidence');
        if (target.kind === 'open-bounded-evidence') expect(target.rows).toHaveLength(count);
      }
    },
  );
});

// ── the prototype's commit grid and PR branches (rich evidence bodies) ─────
// Both bodies are OPTIONAL fields beside the rows every ship process has
// always carried. Every cell must come from a recorded fact: a repository
// with no recorded commit says so, and a PR whose number was never recorded
// is `no PR`, never a fabricated number.
describe('ship commit evidence: the per-repository commit grid', () => {
  it('names ship-created commits with their shortened sha, message and origin', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { commit: step('commit', { repo: '/web' }) },
              commits: [
                shipCommit('created-by-ship', { sha: '0123456789abcdef', message: 'feat: land it' }),
                shipCommit('before-ship', { sha: 'ffffffffffff', message: 'earlier' }),
              ],
            }),
          },
        }),
      }),
    );
    const ev = views[0]!.evidence!;
    if (ev.kind !== 'commits') throw new Error('expected commits evidence');
    expect(ev.repos).toEqual([
      {
        repo: '/web',
        summary: '1 created · 1 before',
        origin: 'created by ship',
        originKind: 'ship',
        time: formatTime('2026-07-20T12:00:00.000Z'),
        commits: [{ sha: '0123456', message: 'feat: land it' }],
      },
    ]);
  });

  it('reads a repository with only pre-existing commits as existing, not as a delivery', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { commit: step('commit', { repo: '/web' }) },
              commits: [shipCommit('before-ship', { sha: 'aaaaaaaaaa', message: 'earlier' })],
            }),
          },
        }),
      }),
    );
    const ev = views[0]!.evidence!;
    if (ev.kind !== 'commits') throw new Error('expected commits evidence');
    expect(ev.repos?.[0]).toMatchObject({
      origin: 'already committed',
      originKind: 'existing',
      summary: '0 created · 1 before',
      commits: [{ sha: 'aaaaaaa', message: 'earlier' }],
    });
  });

  it('states absence for a repository karst recorded no commit for', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: { '/web': repoEvidence('/web', { steps: { commit: step('commit', { repo: '/web' }) } }) },
        }),
      }),
    );
    const ev = views[0]!.evidence!;
    if (ev.kind !== 'commits') throw new Error('expected commits evidence');
    expect(ev.repos?.[0]).toMatchObject({
      origin: 'no commits recorded',
      originKind: 'none',
      commits: [],
    });
  });

  it('attaches the opaque open-commit capability to every listed commit', () => {
    const targets: InsideEvidenceTarget[] = [];
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { commit: step('commit', { repo: '/web' }) },
              commits: [
                shipCommit('created-by-ship', { id: 77, sha: 'abcdef0123', message: 'one' }),
                shipCommit('created-by-ship', { id: 78, sha: '9876543210', message: 'two' }),
              ],
            }),
          },
        }),
        attach: (target) => {
          targets.push(target);
          return { actionId: `snapshot-1:a${targets.length}`, kind: target.kind };
        },
      }),
    );
    const ev = views[0]!.evidence!;
    if (ev.kind !== 'commits') throw new Error('expected commits evidence');
    expect(ev.repos?.[0]?.commits.map((c) => c.action?.kind)).toEqual(['open-commit', 'open-commit']);
    expect(targets.filter((t) => t.kind === 'open-commit')).toEqual([
      { kind: 'open-commit', shipCommitId: 77 },
      { kind: 'open-commit', shipCommitId: 78 },
    ]);
  });

  it('bounds the repository blocks and carries the continuation on the overflow', () => {
    const repos: ShipEvidence['repos'] = {};
    for (let i = 0; i < 9; i += 1) {
      repos[`/r${i}`] = repoEvidence(`/r${i}`, { steps: { commit: step('commit', { repo: `/r${i}` }) } });
    }
    const views = shipProcesses(
      shipInput({
        evidence: evidence({ repos }),
        attach: (target) => ({ actionId: 'snapshot-1:a1', kind: target.kind }),
      }),
    );
    const ev = views[0]!.evidence!;
    if (ev.kind !== 'commits') throw new Error('expected commits evidence');
    expect(ev.repos).toHaveLength(6);
    expect(ev.overflow).toMatchObject({
      label: 'more',
      detail: '+3 more',
      action: { kind: 'open-bounded-evidence' },
    });
  });
});

describe('ship pr evidence: the per-repository branch path', () => {
  it('names a created PR, its recorded state and the path that produced it', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: {
                describe: step('describe', { repo: '/web' }),
                pr: step('pr', { repo: '/web', number: 412, existedBeforeShip: false }),
              },
            }),
          },
        }),
        prs: [pr('/web', { number: 412, status: 'open' })],
      }),
    );
    const ev = views[2]!.evidence!;
    if (ev.kind !== 'prs') throw new Error('expected prs evidence');
    expect(ev.branches?.[0]).toEqual({
      repo: '/web',
      number: '#412',
      prState: 'open',
      steps: [
        { label: 'description generated', state: 'done' },
        { label: 'PR opened', state: 'done' },
      ],
      note: 'PR #412 was created in this ship run.',
      current: false,
      // Every expanded row dates itself, like the commit blocks beside it.
      time: formatTime('2026-07-20T12:00:00.000Z'),
    });
  });

  it('reads an adopted PR as a keep, never as a create', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { pr: step('pr', { repo: '/web', number: 9, existedBeforeShip: true }) },
            }),
          },
        }),
        prs: [pr('/web', { number: 9, status: 'merged' })],
      }),
    );
    const ev = views[2]!.evidence!;
    if (ev.kind !== 'prs') throw new Error('expected prs evidence');
    expect(ev.branches?.[0]).toMatchObject({
      number: '#9',
      prState: 'merged',
      steps: [{ label: 'PR adopted', state: 'done' }],
      note: 'No create step because #9 already existed.',
    });
  });

  it('shows no PR object and no fabricated number when none was recorded', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { pr: step('pr', { repo: '/web', status: 'note', detail: 'no changes' }) },
            }),
          },
        }),
      }),
    );
    const ev = views[2]!.evidence!;
    if (ev.kind !== 'prs') throw new Error('expected prs evidence');
    expect(ev.branches?.[0]).toMatchObject({
      number: '',
      prState: '',
      emptyLabel: 'no PR',
      steps: [{ label: 'no PR needed', state: 'note' }],
      note: 'No PR was created because this repository had no changes.',
      current: false,
    });
  });

  it('marks a failed pr step current and names the failure without inventing a number', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { pr: step('pr', { repo: '/web', status: 'failed', detail: 'gh exited 1' }) },
            }),
          },
        }),
      }),
    );
    const ev = views[2]!.evidence!;
    if (ev.kind !== 'prs') throw new Error('expected prs evidence');
    expect(ev.branches?.[0]).toMatchObject({
      number: '',
      steps: [{ label: 'PR failed', state: 'fail' }],
      note: 'The pull-request step failed: gh exited 1',
      current: true,
    });
  });

  it('bounds the branch rows and carries the continuation on the overflow', () => {
    const repos: ShipEvidence['repos'] = {};
    for (let i = 0; i < 8; i += 1) {
      repos[`/r${i}`] = repoEvidence(`/r${i}`, { steps: { pr: step('pr', { repo: `/r${i}`, number: i }) } });
    }
    const views = shipProcesses(
      shipInput({
        evidence: evidence({ repos }),
        attach: (target) => ({ actionId: 'snapshot-1:a1', kind: target.kind }),
      }),
    );
    const ev = views[2]!.evidence!;
    if (ev.kind !== 'prs') throw new Error('expected prs evidence');
    expect(ev.branches).toHaveLength(6);
    expect(ev.overflow).toMatchObject({ detail: '+2 more', action: { kind: 'open-bounded-evidence' } });
  });
});

describe('ship process rows: descriptions and identity (Task 869egdr2u)', () => {
  it('checks the commit process when every repo is settled — commits with no step included', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { commit: step('commit', { repo: '/web', status: 'passed' }) },
              commits: [shipCommit('created-by-ship')],
            }),
            // A repo that only carried pre-existing commits and recorded no
            // commit STEP is still commit-ready — the checkmark must not
            // depend on a literal passed step.
            '/api': repoEvidence('/api', {
              commits: [shipCommit('before-ship', { repo: '/api' })],
            }),
          },
        }),
      }),
    );
    const commit = views[0]!;
    expect(commit.status).toBe('pass');
    expect(commit.detail).toBe('2 repositories commit-ready · 1 created in Ship');
  });

  it('keeps a nothing-to-commit repo reading as a settled, checked commit phase', () => {
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
    expect(views[0]!.status).toBe('pass');
    expect(views[0]!.detail).toBe('1 repository commit-ready');
  });

  it('leaves the commit process un-checked when a repo records no commit state at all', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: { '/web': repoEvidence('/web') },
        }),
      }),
    );
    expect(views[0]!.status).toBe('note');
  });

  it('states the push outcome on the process row: N / N pushed', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', { steps: { push: step('push', { repo: '/web' }) } }),
            '/api': repoEvidence('/api', { steps: { push: step('push', { repo: '/api' }) } }),
          },
        }),
      }),
    );
    expect(views[1]!.detail).toBe('2/2 pushed');
  });

  it('names each push row existing → update or missing → create from the recorded pre-state', () => {
    const intent = (repo: string, preRemoteHead: string | null) => ({
      id: 1,
      shipRunId: 1,
      repo,
      step: 'push' as const,
      operationKey: `k:${repo}`,
      preStateJson: JSON.stringify({
        step: 'push',
        localHead: 'abc',
        remote: 'origin',
        ref: 'karst/x',
        preRemoteHead,
      }),
      intentJson: null,
      status: 'reconciled' as const,
      createdAt: NOW,
      preparedAt: NOW,
      appliedAt: NOW,
      resolvedAt: NOW,
    });
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { push: step('push', { repo: '/web', detail: 'karst/x' }) },
              intents: { push: intent('/web', 'old-head') },
            }),
            '/api': repoEvidence('/api', {
              steps: { push: step('push', { repo: '/api', detail: 'karst/x' }) },
              intents: { push: intent('/api', null) },
            }),
          },
        }),
      }),
    );
    const rows = rowsOf(views[1]!);
    expect(rows[0]!.label).toBe('/api');
    expect(rows[0]!.detail).toBe('missing → create');
    expect(rows[1]!.label).toBe('/web');
    expect(rows[1]!.detail).toBe('existing → update');
    // A legacy ship with no recorded intent falls back to the step's detail.
    const legacy = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: { '/web': repoEvidence('/web', { steps: { push: step('push', { repo: '/web', detail: 'karst/x' }) } }) },
        }),
      }),
    );
    expect(rowsOf(legacy[1]!)[0]!.detail).toBe('karst/x');
  });

  it('carries the pr-description execution and recorded spend on the Pull request row', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { pr: step('pr', { repo: '/web', number: 40, existedBeforeShip: false }) },
            }),
            '/api': repoEvidence('/api', {
              steps: { pr: step('pr', { repo: '/api', number: 41, existedBeforeShip: true }) },
            }),
          },
        }),
        prs: [pr('/web', { number: 40, status: 'open' }), pr('/api', { number: 41, status: 'merged' })],
        processRuns: [
          {
            id: 5,
            ticketId: 1,
            stageKey: 'ship',
            processId: 'pr-description',
            attempt: 0,
            stageRunId: null,
            agentName: null,
            provider: 'opencode',
            model: 'opencode-go/deepseek-v4-flash',
            pid: null,
            status: 'passed',
            resultKind: null,
            artifactPath: null,
            startedAt: NOW,
            endedAt: NOW,
          },
        ],
        tokens: { total: 1800 },
      }),
    );
    const prRow = views[2]!;
    expect(prRow.execution).toMatchObject({ provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' });
    expect(prRow.tokens?.state).toBe('measured');
    expect(prRow.detail).toBe('1 created · 1 adopted');
  });

  it('mints the open-pr capability on the branch number from the current PR row', () => {
    const targets: InsideEvidenceTarget[] = [];
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: { pr: step('pr', { repo: '/web', number: 412, existedBeforeShip: false }) },
            }),
          },
        }),
        prs: [pr('/web', { id: 77, number: 412, status: 'open' })],
        attach: (target) => {
          targets.push(target);
          return { actionId: `snapshot-1:a${targets.length}`, kind: target.kind };
        },
      }),
    );
    const ev = views[2]!.evidence as { kind: 'prs'; branches?: { action?: { kind: string } }[] };
    expect(ev.branches?.[0]?.action?.kind).toBe('open-pr');
    expect(targets).toEqual([{ kind: 'open-pr', prId: 77 }]);
  });

  it('shows the manifest repository name instead of the recorded path', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/Users/nd/Work/projects/karst/': repoEvidence('/Users/nd/Work/projects/karst/', {
              steps: {
                commit: step('commit', { repo: '/Users/nd/Work/projects/karst/', status: 'passed' }),
                push: step('push', { repo: '/Users/nd/Work/projects/karst/', status: 'passed' }),
                pr: step('pr', { repo: '/Users/nd/Work/projects/karst/', number: 40, existedBeforeShip: false }),
              },
              commits: [shipCommit('created-by-ship', { repo: '/Users/nd/Work/projects/karst/' })],
            }),
          },
        }),
        prs: [pr('/Users/nd/Work/projects/karst/', { number: 40, status: 'open' })],
        repoNameFor: (repo) => (repo === '/Users/nd/Work/projects/karst/' ? 'Karst-extention' : undefined),
      }),
    );
    expect(rowsOf(views[0]!)[0]!.label).toBe('Karst-extention');
    expect(rowsOf(views[1]!)[0]!.label).toBe('Karst-extention');
    expect(rowsOf(views[2]!)[0]!.label).toBe('Karst-extention');
    expect(rowsOf(views[3]!)[0]!.label).toBe('Karst-extention · open');
    const ev = views[0]!.evidence as { kind: 'commits'; repos?: { repo: string }[] };
    expect(ev.repos?.[0]?.repo).toBe('Karst-extention');
  });

  it('dates each merge row from the fact it reads: merged stamp, else last check', () => {
    const views = shipProcesses(
      shipInput({
        prs: [pr('/web', { number: 40, status: 'merged', mergedAt: '2026-07-20T12:05:00.000Z' })],
        mergeChecks: [],
      }),
    );
    expect(rowsOf(views[3]!)[0]!.time).toBe(formatTime('2026-07-20T12:05:00.000Z'));

    const open = shipProcesses(
      shipInput({
        prs: [pr('/web', { number: 41, status: 'open' })],
        mergeChecks: [check('/web', { state: 'clean', checkedAt: '2026-07-20T12:06:00.000Z' })],
      }),
    );
    expect(rowsOf(open[3]!)[0]!.time).toBe(formatTime('2026-07-20T12:06:00.000Z'));
  });
});

// ── 869egdr2u-fu2: every ship process dates ITSELF ────────────────────────
// A per-repo row answers "when did THIS repository push"; only the process
// row can answer "when did the push finish".
describe('ship process rows carry their own span', () => {
  const spanned = () =>
    shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', {
              steps: {
                commit: step('commit', {
                  startedAt: '2026-07-20T12:00:00.000Z',
                  endedAt: '2026-07-20T12:00:20.000Z',
                }),
                push: step('push', {
                  startedAt: '2026-07-20T12:00:30.000Z',
                  endedAt: '2026-07-20T12:00:40.000Z',
                }),
                pr: step('pr', {
                  startedAt: '2026-07-20T12:01:00.000Z',
                  endedAt: '2026-07-20T12:01:30.000Z',
                  number: 5,
                }),
              },
            }),
            '/api': repoEvidence('/api', {
              steps: {
                push: step('push', {
                  repo: '/api',
                  startedAt: '2026-07-20T12:00:35.000Z',
                  endedAt: '2026-07-20T12:01:05.000Z',
                }),
              },
            }),
          },
        }),
        prs: [pr('/web', { number: 5, status: 'merged', mergedAt: '2026-07-20T12:20:00.000Z' })],
      }),
    );

  it('spans push from the earliest start to the latest end across repositories', () => {
    const push = spanned()[1]!;
    expect(push.time).toBe(formatTime('2026-07-20T12:00:30.000Z'));
    // 12:00:30 → 12:01:05, the LAST repository to finish.
    expect(push.durationExact).toBe('35.000s');
  });

  it('spans commit and pull request the same way', () => {
    const [commit, , prProcess] = spanned();
    expect(commit!.time).toBe(formatTime('2026-07-20T12:00:00.000Z'));
    expect(commit!.durationExact).toBe('20.000s');
    expect(prProcess!.time).toBe(formatTime('2026-07-20T12:01:00.000Z'));
    expect(prProcess!.durationExact).toBe('30.000s');
  });

  it('dates merge from the landing fact it read, not from a step it never ran', () => {
    const merge = spanned()[3]!;
    expect(merge.time).toBe(formatTime('2026-07-20T12:20:00.000Z'));
    // Merge runs nothing, so it has a moment and no span.
    expect(merge.duration).toBeUndefined();
  });

  it('states no time at all when no step recorded a start', () => {
    const views = shipProcesses(
      shipInput({
        evidence: evidence({
          repos: {
            '/web': repoEvidence('/web', { steps: { push: step('push', { startedAt: undefined }) } }),
          },
        }),
      }),
    );
    expect(views[1]!.time).toBeUndefined();
    expect(views[1]!.duration).toBeUndefined();
  });
});
