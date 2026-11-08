import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { transition } from '../machine.js';
import { runUatTester, type RunUatTesterOpts, type TesterTarget } from './tester.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { checkProbeEvidence, defaultEvidenceFs, globStaticDir, MAX_EVIDENCE_FILES, type EvidenceFs } from './testerEvidence.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reaskPrefix } from './testerSkip.js';
import type { AgentAdapter, HeadlessResult, RunHeadlessOpts } from '../../agent/adapter.js';
import type { GitRunner } from '../../integrations/git.js';
import type { UatTesterRequireEvidence } from '../../manifest/types.js';

const START = Date.parse('2026-08-08T10:00:00.000Z');
const now = () => '2026-08-08T10:00:00.000Z';
const RULE: UatTesterRequireEvidence = {
  file: '.karst/uat-scratch/out/**/summary.json',
  whenChanged: ['src/ui/**', 'src/extension.ts'],
};
const SUMMARY = '.karst/uat-scratch/out/run1/summary.json';

const gitDiff = (paths: string[]): GitRunner => async (args) =>
  args[0] === 'diff'
    ? { exitCode: 0, stdout: paths.join('\n'), stderr: '' }
    : { exitCode: 1, stdout: '', stderr: '' };

const PASSING_SUMMARY = JSON.stringify({ total: 1, ran: 1, results: [{ status: 'pass' }] });

const fakeFs = (files: Record<string, { mtimeMs: number; body?: string }>): EvidenceFs => ({
  list: async () => Object.entries(files).map(([rel, f]) => ({ rel, mtimeMs: f.mtimeMs })),
  read: async (path) => files[path.slice(path.indexOf('.karst'))]?.body ?? PASSING_SUMMARY,
});

const input = (over: Partial<Parameters<typeof checkProbeEvidence>[0]>) => ({
  rule: RULE,
  worktreePath: '/wt',
  baseRef: 'develop',
  branch: 'ticket',
  startedAtMs: START,
  git: gitDiff(['src/ui/a.ts']),
  fs: fakeFs({ [SUMMARY]: { mtimeMs: START + 1000 } }),
  ...over,
});

describe('checkProbeEvidence', () => {
  it('a newer evidence file means present', async () => {
    expect(await checkProbeEvidence(input({}))).toEqual({ kind: 'present' });
  });
  it('an older evidence file means missing, and the detail names the glob', async () => {
    const res = await checkProbeEvidence(input({ fs: fakeFs({ [SUMMARY]: { mtimeMs: START - 1 } }) }));
    expect(res).toMatchObject({ kind: 'missing' });
    expect((res as { detail: string }).detail).toContain('.karst/uat-scratch/out/**/summary.json');
  });
  it('a file that does not match the glob is not evidence', async () => {
    const res = await checkProbeEvidence(input({ fs: fakeFs({ 'other/summary.json': { mtimeMs: START + 5 } }) }));
    expect(res.kind).toBe('missing');
  });
  it('a diff outside whenChanged means no check', async () => {
    const res = await checkProbeEvidence(input({ git: gitDiff(['docs/a.md']), fs: fakeFs({}) }));
    expect(res).toEqual({ kind: 'not-required' });
  });
  it('no rule means no check', async () => {
    expect(await checkProbeEvidence(input({ rule: undefined, fs: fakeFs({}) }))).toEqual({ kind: 'not-required' });
  });
  it('a git failure means no check (fail open)', async () => {
    const git: GitRunner = async () => ({ exitCode: 128, stdout: '', stderr: 'x' });
    expect(await checkProbeEvidence(input({ git, fs: fakeFs({}) }))).toEqual({ kind: 'not-required' });
  });
  it('a summary whose first step failed still counts as evidence, and the detail says so', async () => {
    const body = JSON.stringify({ total: 2, ran: 1, results: [{ status: 'timeout' }] });
    const res = await checkProbeEvidence(input({ fs: fakeFs({ [SUMMARY]: { mtimeMs: START + 1, body } }) }));
    expect(res.kind).toBe('present');
    expect((res as { detail: string }).detail).toContain('harness failure');
  });
  it('an unreadable summary still counts as evidence, and the detail says so', async () => {
    const res = await checkProbeEvidence(input({ fs: fakeFs({ [SUMMARY]: { mtimeMs: START + 1, body: '{not json' } }) }));
    expect(res.kind).toBe('present');
    expect((res as { detail: string }).detail).toContain('could not be read');
  });
  it('a summary the file system cannot read still counts as evidence, and the detail says so', async () => {
    const base = fakeFs({ [SUMMARY]: { mtimeMs: START + 1 } });
    const fs: EvidenceFs = { list: base.list, read: async () => { throw new Error('EACCES'); } };
    const res = await checkProbeEvidence(input({ fs }));
    expect(res.kind).toBe('present');
    expect((res as { detail: string }).detail).toContain('could not be read');
  });
  it('a file system error means unverifiable, never a throw', async () => {
    const fs: EvidenceFs = { list: async () => { throw new Error('EACCES'); }, read: async () => '' };
    const res = await checkProbeEvidence(input({ fs }));
    expect(res).toMatchObject({ kind: 'unverifiable' });
    expect((res as { detail: string }).detail).toContain('EACCES');
  });
  it('globStaticDir returns the directory before the first wildcard', () => {
    expect(globStaticDir('.karst/uat-scratch/out/**/summary.json')).toBe('.karst/uat-scratch/out');
    expect(globStaticDir('*.json')).toBe('');
    expect(globStaticDir('a/b/c.json')).toBe('a/b');
  });
});

const cov = (text: string) => [{ severity: 'info', title: `COVERAGE (reported): ${text}`, detail: '' }];
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
const target: TesterTarget = { repo: '/web', worktreePath: '/wt/web', baseRef: 'develop', runningServices: [] };

describe('runUatTester — requireEvidence', () => {
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
    targets: [target],
    assignment: { agentName: 'UAT Agent', provider: 'claude', model: 'm' },
    adapter,
    git: gitDiff(['src/workflow/x.ts']),
    requireEvidence: { ...RULE, whenChanged: ['src/workflow/**'] },
    ...over,
  });
  const none = { evidenceFs: fakeFs({}) };
  const kinds = () => listProcessRuns(store, ticketId).map((r) => [r.status, r.resultKind]);
  // A PASS answer that never mentions a core: only the files decide.
  const pass = [...cov('PASS — checked'), { severity: 'low', title: 'nit', detail: '' }];

  it('no evidence → skipped even when the answer reports a PASS, detail names the evidence', async () => {
    const { adapter } = scripted([pass]);
    const res = await runUatTester(store, opts(adapter), { now, ...none });
    expect(res).toMatchObject({ kind: 'skipped' });
    expect((res as { detail: string }).detail).toContain('no probe evidence');
    expect(kinds()).toEqual([['passed', 'skipped']]);
  });

  it('a blocking observation survives missing evidence: observed, never skipped', async () => {
    const { adapter } = scripted([[...cov('PASS — x'), { severity: 'high', title: 'bad', detail: '' }]]);
    const res = await runUatTester(store, opts(adapter, { observationsBlockingSeverity: 'medium' }), { now, ...none });
    expect(res).toMatchObject({ kind: 'observed', blocking: 1 });
  });

  it('evidence newer than the run start → observed', async () => {
    const { adapter } = scripted([pass]);
    const evidenceFs = fakeFs({ [SUMMARY]: { mtimeMs: Date.now() } });
    expect((await runUatTester(store, opts(adapter), { now, evidenceFs })).kind).toBe('observed');
  });

  it('an old evidence file → skipped', async () => {
    const { adapter } = scripted([pass]);
    const evidenceFs = fakeFs({ [SUMMARY]: { mtimeMs: START - 1 } });
    expect((await runUatTester(store, opts(adapter), { now, evidenceFs })).kind).toBe('skipped');
  });

  it('a diff outside whenChanged → no check', async () => {
    const { adapter } = scripted([pass]);
    const res = await runUatTester(store, opts(adapter, { git: gitDiff(['README.md']) }), { now, ...none });
    expect(res.kind).toBe('observed');
  });

  it('no field → no check', async () => {
    const { adapter } = scripted([pass]);
    const res = await runUatTester(store, opts(adapter, { requireEvidence: undefined }), { now, ...none });
    expect(res.kind).toBe('observed');
  });

  it.each(['claude', 'codex', 'opencode'] as const)('the verdict is the same for provider %s', async (provider) => {
    const { adapter } = scripted([pass]);
    const o = opts(adapter, { assignment: { agentName: 'UAT Agent', provider, model: 'm' } });
    expect((await runUatTester(store, o, { now, ...none })).kind).toBe('skipped');
    const fresh = fakeFs({ [SUMMARY]: { mtimeMs: Date.now() } });
    expect((await runUatTester(store, o, { now, evidenceFs: fresh })).kind).toBe('observed');
  });

  it('onSkip pass: one call, no re-ask', async () => {
    const { adapter, calls } = scripted([pass]);
    await runUatTester(store, opts(adapter, { onSkip: 'pass' }), { now, ...none });
    expect(calls).toHaveLength(1);
  });

  it('onSkip reask with no evidence re-asks exactly once, then ends skipped', async () => {
    const { adapter, calls } = scripted([pass]);
    const res = await runUatTester(store, opts(adapter, { onSkip: 'reask' }), { now, ...none });
    expect(res.kind).toBe('skipped');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('This run needs at least one probe run.');
    expect(calls[0]!.prompt).not.toContain('Your previous UAT run');
    expect(kinds()).toEqual([
      ['passed', 'skipped'],
      ['passed', 'skipped'],
    ]);
  });

  it('the re-ask quotes both the coverage skip and the missing evidence', async () => {
    const { adapter, calls } = scripted([cov('SKIPPED — x')]);
    await runUatTester(store, opts(adapter, { onSkip: 'reask' }), { now, ...none });
    expect(calls[1]!.prompt.startsWith(reaskPrefix('COVERAGE (reported): SKIPPED — x'))).toBe(true);
    expect(calls[1]!.prompt).toContain('left no probe evidence');
  });

  it('a harness-failure summary is evidence: no skip and no re-ask', async () => {
    const { adapter, calls } = scripted([pass]);
    const body = JSON.stringify({ total: 1, ran: 1, results: [{ status: 'fail' }] });
    const evidenceFs = fakeFs({ [SUMMARY]: { mtimeMs: Date.now(), body } });
    const res = await runUatTester(store, opts(adapter, { onSkip: 'reask' }), { now, evidenceFs });
    expect(res.kind).toBe('observed');
    expect(calls).toHaveLength(1);
  });

  it('a re-ask that produces evidence replaces the result with observed', async () => {
    const { adapter, calls } = scripted([pass]);
    let listed = 0;
    const evidenceFs: EvidenceFs = {
      list: async () => (++listed < 2 ? [] : [{ rel: SUMMARY, mtimeMs: Date.now() }]),
      read: async () => '',
    };
    const res = await runUatTester(store, opts(adapter, { onSkip: 'reask' }), { now, evidenceFs });
    expect(res.kind).toBe('observed');
    expect(calls).toHaveLength(2);
  });
});

describe('defaultEvidenceFs (real files)', () => {
  it('fails the walk past the entry limit instead of truncating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evidence-'));
    try {
      await mkdir(join(root, 'out'), { recursive: true });
      await Promise.all(Array.from({ length: MAX_EVIDENCE_FILES + 5 }, (_, i) => writeFile(join(root, `out/f${i}`), '')));
      await expect(defaultEvidenceFs.list(root, 'out', () => true)).rejects.toThrow('entries under out');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists nested files with mtimes, treats a missing dir as empty, and reads text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evidence-'));
    try {
      await mkdir(join(root, 'out/run1'), { recursive: true });
      await writeFile(join(root, 'out/run1/summary.json'), '{"a":1}');
      await writeFile(join(root, 'out/top.txt'), 'x');
      const files = await defaultEvidenceFs.list(root, 'out', () => true);
      expect(files.map((f) => f.rel).sort()).toEqual(['out/run1/summary.json', 'out/top.txt']);
      expect(files.every((f) => f.mtimeMs > 0)).toBe(true);
      expect(await defaultEvidenceFs.list(root, 'absent', () => true)).toEqual([]);
      expect(await defaultEvidenceFs.read(join(root, 'out/top.txt'))).toBe('x');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('end to end: a fresh summary on disk is evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evidence-'));
    try {
      await mkdir(join(root, '.karst/uat-scratch/out/r'), { recursive: true });
      await writeFile(join(root, SUMMARY.replace('run1', 'r')), '{"results":[{"status":"pass"}]}');
      const res = await checkProbeEvidence(input({ worktreePath: root, fs: undefined, startedAtMs: Date.now() - 60_000 }));
      expect(res).toEqual({ kind: 'present' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
