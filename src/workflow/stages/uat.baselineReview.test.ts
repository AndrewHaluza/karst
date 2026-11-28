import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { listGateRuns, recordGateRun } from '../../store/gateRuns.js';
import { transition } from '../machine.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { recordBaselineDecisions } from '../../store/baselineDecisions.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { manifest, uat as uatConfig } from '../../manifest/fixtures.js';
import { runUat, type UatDeps } from './uat.js';
import type { BaselineEntry } from '../gates/baselineReview.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { precheckBaselines } from '../gates/baselinePrecheck.js';

const now = () => '2026-07-30T10:00:00.000Z';

const ENTRY: BaselineEntry = {
  repo: '/web',
  cwd: '/wt/web',
  path: 'tests/visual/__baselines__/settings.png',
  status: 'modified',
  newSha256: 'sha-1',
  mergeBase: 'abc',
  autoApproved: false,
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
    fingerprint: async () => null,
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

  describe('gate fingerprint', () => {
    const countingGates = () => {
      let ran = 0;
      const runGates: UatDeps['runGates'] = async (gates, _cwd, opts) => {
        ran += 1;
        const results = gates.map((g, i) => {
          opts?.onGateComplete?.(g.name, 0, now(), now(), i);
          return { name: g.name, exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() };
        });
        return { kind: 'ran' as const, results };
      };
      return { runGates, ran: () => ran };
    };

    it('records the pass, then skips the gate list on re-entry with an unchanged tree', async () => {
      const gates = countingGates();
      const d = deps({ runGates: gates.runGates, fingerprint: async () => 'fp-1' });
      expect(await run(d)).toMatchObject({ kind: 'blocked', blocker: 'baseline-review' });
      expect(gates.ran()).toBe(1);
      // The user approved; the stage re-enters with the same tree.
      recordBaselineDecisions(
        store, id,
        [{ repo: ENTRY.repo, path: ENTRY.path, sha256: 'sha-1', decision: 'approved', reason: null }],
        now(),
      );
      expect(await run(d)).toEqual({ kind: 'advanced', next: 'review' });
      expect(gates.ran()).toBe(1); // not run again
    });

    it('runs the full gate list again when the tree changed', async () => {
      const gates = countingGates();
      let fp = 'fp-1';
      const d = deps({ runGates: gates.runGates, fingerprint: async () => fp });
      await run(d);
      fp = 'fp-2';
      await run(d);
      expect(gates.ran()).toBe(2);
    });

    it('runs the gate list when the fingerprint cannot be computed', async () => {
      const gates = countingGates();
      const d = deps({ runGates: gates.runGates, fingerprint: async () => null });
      await run(d);
      await run(d);
      expect(gates.ran()).toBe(2);
    });

    it('never fingerprints without the manifest knob', async () => {
      let called = false;
      await run(deps({ fingerprint: async () => ((called = true), 'fp') }), manifest({}));
      expect(called).toBe(false);
    });
  });

  describe('model pre-check (@arch:BASELINE-PRECHECK)', () => {
    const COVERAGE_ANSWER = JSON.stringify([
      { severity: 'info', title: 'COVERAGE (reported): PASS — checked the change', detail: '' },
    ]);

    const withPrecheck = (over: { paths?: string[]; precheck?: boolean } = {}) =>
      manifest(
        {},
        {
          uat: uatConfig({
            baselineReview: {
              paths: over.paths ?? ['tests/visual/__baselines__/**'],
              ...(over.precheck === undefined ? { precheck: true } : { precheck: over.precheck }),
            },
          }),
        },
      );

    const testerAgent = (): { assignment: { agentName: string; provider: 'claude' }; adapter: AgentAdapter; runHeadless: ReturnType<typeof vi.fn> } => {
      const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: COVERAGE_ANSWER }));
      return {
        assignment: { agentName: 'UAT Agent', provider: 'claude' },
        adapter: {
          requiredBinary: 'fake',
          capabilities: { lifecycleEvents: false, resume: false },
          buildInteractiveCommand: () => {
            throw new Error('not used by the Tester');
          },
          runHeadless,
        } as AgentAdapter,
        runHeadless,
      };
    };

    type PrecheckSeam = NonNullable<UatDeps['precheckBaselines']>;
    const seam = (impl: PrecheckSeam) => vi.fn(impl);

    const approving = (reason = 'clearly the intended settings change'): PrecheckSeam =>
      async (input) => ({
        approved: input.entries.map((entry) => ({
          repo: entry.repo,
          path: entry.path,
          sha256: entry.newSha256,
          reason,
        })),
      });
    const approvingOnly = (path: string, reason = 'clearly the intended settings change'): PrecheckSeam =>
      async (input) => ({
        approved: input.entries
          .filter((entry) => entry.path === path)
          .map((entry) => ({ repo: entry.repo, path: entry.path, sha256: entry.newSha256, reason })),
      });
    const approvingNothing = (): PrecheckSeam => async () => ({ approved: [] });

    const runWith = (d: UatDeps, m = withPrecheck()) =>
      runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir, manifest: m }, d);

    const report = () =>
      readdirSync(artifactDir)
        .map((file) => readFileSync(join(artifactDir, file), 'utf8'))
        .join('\n');

    it('approves every entry, records the pre-check as the decider, and runs the Tester in the same run', async () => {
      const tester = testerAgent();
      const res = await runWith(
        deps({
          detectBaselines: async () => [ENTRY],
          precheckBaselines: seam(approving()),
          tester: { assignment: tester.assignment, adapter: tester.adapter },
        }),
      );
      expect(res).toEqual({ kind: 'advanced', next: 'review' });
      expect(tester.runHeadless).toHaveBeenCalled();
      expect(
        store.db
          .prepare('SELECT decision, decided_by, reason FROM baseline_decisions WHERE ticket_id = ?')
          .get(id),
      ).toEqual({
        decision: 'approved',
        decided_by: 'precheck',
        reason: 'pre-check: clearly the intended settings change',
      });
      expect(report()).toContain('# baseline pre-check');
      expect(report()).toContain(
        `${ENTRY.repo}:${ENTRY.path} — pre-check: clearly the intended settings change`,
      );
      expect(report()).toContain('1 approved by the pre-check, 0 left for you');
    });

    it('blocks only on the leftovers, names the approved count, and reports both halves', async () => {
      const other: BaselineEntry = {
        ...ENTRY,
        path: 'tests/visual/__baselines__/dashboard.png',
        newSha256: 'sha-2',
      };
      const res = await runWith(
        deps({
          detectBaselines: async () => [ENTRY, other],
          precheckBaselines: seam(approvingOnly(ENTRY.path)),
        }),
      );
      expect(res).toEqual({
        kind: 'blocked',
        blocker: 'baseline-review',
        reason:
          '1 visual baseline(s) changed — review in the UAT report (1 approved by the pre-check)',
      });
      expect(report()).toContain('# baseline pre-check');
      expect(report()).toContain(`${ENTRY.repo}:${ENTRY.path} — pre-check: clearly the intended settings change`);
      expect(report()).toContain('1 approved by the pre-check, 1 left for you');
      expect(report()).toContain(`# baseline review\nmodified ${other.repo}:${other.path}`);
    });

    it('a throwing pre-check approves nothing and blocks exactly as today', async () => {
      const debug = vi.fn();
      const res = await runUat(
        store,
        { ticketId: id, cwd: '/wt/web', artifactDir, manifest: withPrecheck(), debug },
        deps({
          detectBaselines: async () => [ENTRY],
          precheckBaselines: seam(async () => {
            throw new Error('model exploded');
          }),
        }),
      );
      expect(res).toEqual({
        kind: 'blocked',
        blocker: 'baseline-review',
        reason: '1 visual baseline(s) changed — review in the UAT report',
      });
      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM baseline_decisions WHERE ticket_id = ?').get(id),
      ).toEqual({ n: 0 });
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('failed (model exploded)'));
    });

    it('skips with the catalog reason when the Tester model is tagged text-only, through the real gate', async () => {
      const tester = testerAgent();
      const textOnly = {
        claude: [
          { id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude' as const], tags: ['text-only' as const] },
        ],
        codex: [],
        antigravity: [],
        opencode: [],
        opencode2: [],
      };
      const debug = vi.fn();
      const res = await runUat(
        store,
        { ticketId: id, cwd: '/wt/web', artifactDir, manifest: withPrecheck(), debug },
        deps({
          detectBaselines: async () => [ENTRY],
          tester: {
            assignment: { ...tester.assignment, model: 'claude-sonnet-5' },
            adapter: tester.adapter,
          },
          catalog: () => textOnly,
        }),
      );
      expect(res).toEqual({
        kind: 'blocked',
        blocker: 'baseline-review',
        reason: '1 visual baseline(s) changed — review in the UAT report',
      });
      const lines = debug.mock.calls.map(([line]) => String(line));
      expect(
        lines.some((line) =>
          line.includes('skipped — model claude-sonnet-5 cannot read images (catalog tags)'),
        ),
      ).toBe(true);
      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM baseline_decisions WHERE ticket_id = ?').get(id),
      ).toEqual({ n: 0 });
      expect(listProcessRuns(store, id)).toEqual([]);
    });

    it('never runs with the knob off', async () => {
      const precheck = seam(approving());
      const res = await runWith(
        deps({ detectBaselines: async () => [ENTRY], precheckBaselines: precheck }),
        withPrecheck({ precheck: false }),
      );
      expect(precheck).not.toHaveBeenCalled();
      expect(res).toEqual({
        kind: 'blocked',
        blocker: 'baseline-review',
        reason: '1 visual baseline(s) changed — review in the UAT report',
      });
    });

    it('states in one debug line that the knob off skipped the pre-check', async () => {
      const debug = vi.fn();
      await runUat(
        store,
        { ticketId: id, cwd: '/wt/web', artifactDir, manifest: withPrecheck({ precheck: false }), debug },
        deps({ detectBaselines: async () => [ENTRY], precheckBaselines: seam(approving()) }),
      );
      const lines = debug.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('pre-check'));
      expect(lines.filter((line) => line.includes('skipped — pre-check disabled'))).toHaveLength(1);
    });

    it('never runs when a gate fails: the gate failure keeps precedence', async () => {
      const precheck = seam(approving());
      const res = await runWith(
        deps({
          detectBaselines: async () => [ENTRY],
          precheckBaselines: precheck,
          runGates: async (gates) => ({
            kind: 'ran',
            results: gates.map((g) => ({
              name: g.name, exitCode: 1, output: 'boom', startedAt: now(), endedAt: now(),
            })),
          }),
        }),
      );
      expect(res).toEqual({ kind: 'advanced', next: 'fix' });
      expect(precheck).not.toHaveBeenCalled();
    });

    it('never runs on the user-approval re-entry (skipGates)', async () => {
      const tester = testerAgent();
      const precheck = seam(approvingNothing());
      const d = deps({
        detectBaselines: async () => [ENTRY],
        precheckBaselines: precheck,
        fingerprint: async () => 'fp-1',
        tester: { assignment: tester.assignment, adapter: tester.adapter },
      });
      expect(await runWith(d)).toMatchObject({ kind: 'blocked', blocker: 'baseline-review' });
      expect(precheck).toHaveBeenCalledTimes(1);
      // Same tree in the same attempt: the gate list is skipped, and so is the pre-check.
      expect(await runWith(d)).toMatchObject({ kind: 'blocked', blocker: 'baseline-review' });
      expect(precheck).toHaveBeenCalledTimes(1);
    });

    it('never runs on a usage-limit rerun', async () => {
      store.db
        .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'web', '/wt/web', 'karst/web', 'develop');
      recordGateRun(store, {
        ticketId: id,
        stageKey: 'uat',
        attempt: 0,
        runAt: now(),
        stageRunId: null,
        gates: [
          { gateName: 'test (web)', exitCode: 0, startedAt: now(), endedAt: now(), repo: 'web', command: 'npm', args: ['test'] },
        ],
      });
      const tester = testerAgent();
      const precheck = seam(approving());
      const res = await runUat(
        store,
        {
          ticketId: id,
          cwd: '/wt/web',
          artifactDir,
          manifest: withPrecheck(),
          rerun: {
            targets: ['web'],
            previousGateRuns: listGateRuns(store, id),
            siblingObservations: [],
            siblingTargets: [],
            tester: { assignment: tester.assignment, adapter: tester.adapter },
          },
        },
        deps({ detectBaselines: async () => [ENTRY], precheckBaselines: precheck }),
      );
      expect(res).toMatchObject({ kind: 'blocked', blocker: 'baseline-review' });
      expect(precheck).not.toHaveBeenCalled();
    });

    it('never runs when there is no pending entry', async () => {
      const precheck = seam(approving());
      const res = await runWith(
        deps({ detectBaselines: async () => [], precheckBaselines: precheck }),
      );
      expect(res).toEqual({ kind: 'advanced', next: 'review' });
      expect(precheck).not.toHaveBeenCalled();
    });

    it('passes the branch src/ui paths to the pre-check, and an unreadable diff is an empty list', async () => {
      const seen: string[][] = [];
      const precheck = seam(async (input) => {
        seen.push([...input.uiPaths]);
        return { approved: [] };
      });
      const git = vi.fn(async (args: readonly string[]) =>
        args[0] === 'diff'
          ? { exitCode: 0, stdout: 'src/ui/settings/app/main.tsx\nsrc/ui/dashboard/app/main.tsx\n', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'no' },
      ) as unknown as UatDeps['git'];
      await runWith(
        deps({ detectBaselines: async () => [ENTRY], precheckBaselines: precheck, git }),
      );
      expect(seen[0]).toEqual(['src/ui/settings/app/main.tsx', 'src/ui/dashboard/app/main.tsx']);
      expect(git).toHaveBeenCalledWith(
        ['diff', '--name-only', ENTRY.mergeBase, 'HEAD', '--', 'src/ui'],
        ENTRY.cwd,
      );

      seen.length = 0;
      await runWith(
        deps({
          detectBaselines: async () => [ENTRY],
          precheckBaselines: precheck,
          git: async () => {
            throw new Error('no git');
          },
        }),
      );
      expect(seen[0]).toEqual([]);
    });
  });
});
