import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { transition } from '../machine.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { listUatFindings } from '../../store/uatFindings.js';
import { runUatTester, type RunUatTesterOpts, type TesterTarget } from './tester.js';
import { MAX_SKIP_DETAIL } from '../../model/coverageRecord.js';
import { observedNothing, skippedDetail, reaskPrefix } from './testerSkip.js';
import type { AgentAdapter, HeadlessResult, RunHeadlessOpts } from '../../agent/adapter.js';
import type { GitRunner } from '../../integrations/git.js';

const now = () => '2026-08-08T10:00:00.000Z';
const neverGit: GitRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
const target = (repo: string): TesterTarget => ({
  repo,
  worktreePath: `/wt${repo}`,
  baseRef: 'develop',
  runningServices: [],
});
const cov = (text: string) => [{ severity: 'info', title: `COVERAGE (reported): ${text}`, detail: '' }];
const SKIP_TITLE = 'COVERAGE (reported): SKIPPED — uat:host probe not run; unit tests only';

/** Answers from `answers` in call order (the last one repeats). */
function scripted(answers: unknown[][]): { adapter: AgentAdapter; calls: RunHeadlessOpts[] } {
  const calls: RunHeadlessOpts[] = [];
  const adapter: AgentAdapter = {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => {
      throw new Error('not used');
    },
    runHeadless: async (o): Promise<HeadlessResult> => {
      const n = Math.min(calls.length, answers.length - 1);
      calls.push(o);
      return { sessionId: '', verdict: null, raw: JSON.stringify(answers[n]) };
    },
  };
  return { adapter, calls };
}

describe('testerSkip helpers', () => {
  it('detects a target that observed nothing', () => {
    expect(observedNothing(SKIP_TITLE, 0)).toBe(true);
    expect(observedNothing('COVERAGE (reported): NOT RUN — x', 0)).toBe(true);
    expect(observedNothing(SKIP_TITLE, 1)).toBe(false);
    expect(observedNothing('COVERAGE (reported): PASS — x', 0)).toBe(false);
  });

  it('prefixes the repo only when several targets were asked, and cuts to 160 chars', () => {
    expect(skippedDetail({ repo: 'extention', title: SKIP_TITLE }, 1)).toBe('uat:host probe not run; unit tests only');
    expect(skippedDetail({ repo: 'extention', title: SKIP_TITLE }, 2)).toBe(
      'extention: uat:host probe not run; unit tests only',
    );
    const long = skippedDetail({ repo: 'r', title: `COVERAGE (reported): SKIPPED — ${'x'.repeat(400)}\nsecond` }, 1);
    expect(long).toHaveLength(160);
    expect(long).not.toContain('\n');
  });

  it('quotes the previous coverage title in the exact re-ask text', () => {
    expect(reaskPrefix('T')).toBe(
      'Your previous UAT run on this ticket observed nothing. You reported: "T".\n' +
        "Before you report SKIPPED again, try to exercise the change another way: install what is missing in the worktree, or run the project's own test or UAT command (or run it inside a container). Report SKIPPED again only if that also cannot exercise the change, and name the command you ran and its result.",
    );
  });

  it('keeps the re-ask text project-neutral and caps a long quoted title to one line', () => {
    const text = reaskPrefix(`${'x'.repeat(500)}\nnext`);
    expect(text).not.toContain('uat:host');
    const quoted = text.split('"')[1]!;
    expect(quoted).toHaveLength(MAX_SKIP_DETAIL);
    expect(quoted).not.toContain('\n');
  });
});

describe('runUatTester — a run that observed nothing', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  const opts = (adapter: AgentAdapter, over: Partial<RunUatTesterOpts> = {}): RunUatTesterOpts => ({
    ticketId,
    targets: [target('/web')],
    assignment: { agentName: 'UAT Agent', provider: 'claude', model: 'm' },
    adapter,
    git: neverGit,
    ...over,
  });
  const kinds = () => listProcessRuns(store, ticketId).map((r) => [r.status, r.resultKind]);

  it('SKIPPED + 0 observations → skipped, recorded as passed/skipped, coverage row kept', async () => {
    const { adapter } = scripted([cov('SKIPPED — uat:host probe not run; unit tests only')]);
    const res = await runUatTester(store, opts(adapter), { now });
    expect(res).toEqual({ kind: 'skipped', findingIds: [1], detail: 'uat:host probe not run; unit tests only' });
    expect(kinds()).toEqual([['passed', 'skipped']]);
    expect(listUatFindings(store, ticketId)).toHaveLength(1);
  });

  it('no coverage record at all (host fallback NOT RUN) → skipped', async () => {
    const { adapter } = scripted([[]]);
    const res = await runUatTester(store, opts(adapter), { now });
    expect(res).toMatchObject({ kind: 'skipped', detail: 'the agent reported no coverage record' });
  });

  it('SKIPPED + one observation → observed', async () => {
    const { adapter } = scripted([[...cov('SKIPPED — x'), { severity: 'low', title: 'nit', detail: '' }]]);
    expect((await runUatTester(store, opts(adapter), { now })).kind).toBe('observed');
  });

  it('two targets, one PASS and one SKIPPED → observed', async () => {
    const { adapter } = scripted([cov('PASS — ok'), cov('SKIPPED — x')]);
    const res = await runUatTester(store, opts(adapter, { targets: [target('/a'), target('/b')] }), { now });
    expect(res.kind).toBe('observed');
  });

  it('two skipped targets → skipped, detail names the first repo', async () => {
    const { adapter } = scripted([cov('SKIPPED — a reason')]);
    const res = await runUatTester(store, opts(adapter, { targets: [target('/a'), target('/b')] }), { now });
    expect(res).toMatchObject({ kind: 'skipped', detail: '/a: a reason' });
  });

  it('onSkip pass never re-asks', async () => {
    const { adapter, calls } = scripted([cov('SKIPPED — x')]);
    await runUatTester(store, opts(adapter, { onSkip: 'pass' }), { now });
    expect(calls).toHaveLength(1);
  });

  it('reask sends exactly one extra call per target, with the exact prefix; a second skip stays skipped', async () => {
    const { adapter, calls } = scripted([cov('SKIPPED — first')]);
    const res = await runUatTester(
      store,
      opts(adapter, { onSkip: 'reask', targets: [target('/a'), target('/b')] }),
      { now },
    );
    expect(res.kind).toBe('skipped');
    expect(calls).toHaveLength(4);
    expect(calls[2]!.prompt.startsWith(reaskPrefix('COVERAGE (reported): SKIPPED — first'))).toBe(true);
    expect(calls[0]!.prompt).not.toContain('Your previous UAT run');
    // Two process runs: the first answer and the re-ask.
    expect(kinds()).toEqual([
      ['passed', 'skipped'],
      ['passed', 'skipped'],
    ]);
  });

  it('a re-ask that observes something replaces the result with observed', async () => {
    const { adapter, calls } = scripted([cov('SKIPPED — first'), [...cov('PASS — ran docker'), { severity: 'low', title: 'n', detail: '' }]]);
    const res = await runUatTester(store, opts(adapter, { onSkip: 'reask-then-park' }), { now });
    expect(res.kind).toBe('observed');
    expect(calls).toHaveLength(2);
  });
});
