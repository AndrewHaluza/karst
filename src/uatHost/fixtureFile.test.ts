import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFixtureFile } from './fixtureFile.js';
import { parseSteps } from './probe/steps.js';

const ticket = { key: 'T-1', title: 't', stageCurrent: 'uat' };

describe('parseFixtureFile', () => {
  it('parses a minimal ticket', () => {
    const spec = parseFixtureFile({ tickets: [ticket] });
    expect(spec.tickets[0]).toEqual({ ...ticket, stages: [] });
    expect(spec.provider).toBeUndefined();
  });
  it('parses stages, archived, worktree and provider', () => {
    const spec = parseFixtureFile({
      provider: 'opencode',
      tickets: [{
        ...ticket, archived: true, worktree: true,
        stages: [{ stageKey: 'uat', status: 'running', attempt: 2, blockedKind: 'boot-failed', blockedReason: 'r' }],
      }],
    });
    const t = spec.tickets[0]!;
    expect(spec.provider).toBe('opencode');
    expect(t.archived).toBe(true);
    expect(t.worktree).toBe(true);
    expect(t.stages[0]!.patch).toMatchObject({ status: 'running', attempt: 2, blockedKind: 'boot-failed', blockedReason: 'r' });
    expect(t.stages[0]!.patch.startedAt).toBeDefined();
  });
  it('parses the rows allow-list', () => {
    const spec = parseFixtureFile({
      tickets: [{
        ...ticket,
        rows: {
          stage_runs: [{ stageKey: 'uat', status: 'finished', outcome: 'stopped' }],
          process_runs: [{ stageKey: 'uat', processId: 'tester', status: 'running', stageRun: 0 }],
          gate_runs: [{ stageKey: 'uat', gateName: 'g', exitCode: 1, stageRun: 0 }],
          recovery_rounds: [{ sourceStage: 'uat', sourceProcessId: 'tester', triggerKind: 'gate-failure', triggerDetail: 'd' }],
        },
      }],
    });
    const rows = spec.tickets[0]!.rows!;
    expect(rows.stageRuns![0]!.attempt).toBe(1);
    expect(rows.processRuns![0]!.stageRun).toBe(0);
    expect(rows.gateRuns![0]!.exitCode).toBe(1);
    expect(rows.recoveryRounds![0]!.maxRounds).toBe(3);
  });
  it('seeds a recovery round opened by a dismissed usage-limit park', () => {
    const spec = parseFixtureFile({
      tickets: [{
        ...ticket,
        rows: {
          recovery_rounds: [{
            sourceStage: 'uat', sourceProcessId: 'tester',
            triggerKind: 'usage-limit-dismissed', triggerDetail: 'out of quota',
          }],
        },
      }],
    });
    expect(spec.tickets[0]!.rows!.recoveryRounds![0]!.triggerKind).toBe('usage-limit-dismissed');
  });
  it.each([
    ['non-object root', []],
    ['unknown root key', { tickets: [], sql: 'x' }],
    ['unknown ticket key', { tickets: [{ ...ticket, extra: 1 }] }],
    ['missing key', { tickets: [{ title: 't', stageCurrent: 'uat' }] }],
    ['bad stage key', { tickets: [{ ...ticket, stageCurrent: 'nope' }] }],
    ['bad stage status', { tickets: [{ ...ticket, stages: [{ stageKey: 'uat', status: 'nope' }] }] }],
    ['unknown stage key field', { tickets: [{ ...ticket, stages: [{ stageKey: 'uat', status: 'running', x: 1 }] }] }],
    ['unknown table', { tickets: [{ ...ticket, rows: { tickets: [] } }] }],
    ['unknown row column', { tickets: [{ ...ticket, rows: { stage_runs: [{ stageKey: 'uat', status: 'running', pid: 1 }] } }] }],
    ['finished run without outcome', { tickets: [{ ...ticket, rows: { stage_runs: [{ stageKey: 'uat', status: 'finished' }] } }] }],
    ['dangling stageRun link', { tickets: [{ ...ticket, rows: { gate_runs: [{ stageKey: 'uat', gateName: 'g', exitCode: 0, stageRun: 0 }] } }] }],
    ['bad exitCode', { tickets: [{ ...ticket, rows: { gate_runs: [{ stageKey: 'uat', gateName: 'g', exitCode: 'x' }] } }] }],
    ['non-boolean worktree', { tickets: [{ ...ticket, worktree: 'yes' }] }],
    ['duplicate keys', { tickets: [ticket, ticket] }],
    ['unknown provider', { provider: 'nope', tickets: [] }],
    ['zero attempt', { tickets: [{ ...ticket, stages: [{ stageKey: 'uat', status: 'running', attempt: 0 }] }] }],
  ])('refuses %s', (_name, input) => {
    expect(() => parseFixtureFile(input)).toThrow();
  });
});

describe('parseFixtureFile eval fields', () => {
  const repo = { repoPath: '/task', baseRef: 'main', worktreePath: '/task/.karst/worktrees/T-1' };
  it('parses description, repo binding and taskRepo', () => {
    const spec = parseFixtureFile({
      taskRepo: { name: 'toy', repoPath: '/task', baseRef: 'main', gates: [{ name: 'test', command: 'npm', args: ['test'] }] },
      tickets: [{ ...ticket, description: 'fix it', repo, worktree: true }],
    });
    expect(spec.tickets[0]).toMatchObject({ description: 'fix it', repo });
    expect(spec.taskRepo?.gates).toEqual([{ name: 'test', command: 'npm', args: ['test'] }]);
  });
  it.each([
    ['unknown repo key', { tickets: [{ ...ticket, repo: { ...repo, extra: 1 } }] }],
    ['repo missing baseRef', { tickets: [{ ...ticket, repo: { repoPath: '/t', worktreePath: '/w' } }] }],
    ['empty description', { tickets: [{ ...ticket, description: '' }] }],
    ['unknown gate name', { tickets: [], taskRepo: { name: 'a', repoPath: '/t', baseRef: 'main', gates: [{ name: 'lint', command: 'x' }] } }],
    ['duplicate gate', { tickets: [], taskRepo: { name: 'a', repoPath: '/t', baseRef: 'main', gates: [{ name: 'test', command: 'x' }, { name: 'test', command: 'y' }] } }],
    ['non-string arg', { tickets: [], taskRepo: { name: 'a', repoPath: '/t', baseRef: 'main', gates: [{ name: 'test', command: 'x', args: [1] }] } }],
    ['bad repo name', { tickets: [], taskRepo: { name: 'a b', repoPath: '/t', baseRef: 'main' } }],
    ['unknown taskRepo key', { tickets: [], taskRepo: { name: 'a', repoPath: '/t', baseRef: 'main', url: 'x' } }],
  ])('refuses %s', (_n, input) => {
    expect(() => parseFixtureFile(input)).toThrow();
  });
});

describe('parseFixtureFile fakeCore', () => {
  const headless = (rules: unknown[]) => ({ tickets: [ticket], fakeCore: { headless: rules } });
  it('has no fakeCore by default', () => {
    expect(parseFixtureFile({ tickets: [ticket] }).fakeCore).toBeUndefined();
  });
  it('parses a single raw answer into a one-entry answer list', () => {
    const spec = parseFixtureFile(headless([{ promptIncludes: 'p', raw: '[]', verdict: 'v' }]));
    expect(spec.fakeCore).toEqual({ headless: [{ promptIncludes: 'p', answers: [{ raw: '[]', verdict: 'v' }] }] });
  });
  it('parses an answer list and an empty raw answer', () => {
    const spec = parseFixtureFile(headless([{ promptIncludes: 'p', answers: [{ raw: '' }, { raw: 'x' }] }]));
    expect(spec.fakeCore!.headless[0]!.answers.map((a) => a.raw)).toEqual(['', 'x']);
  });
  it('fills the unreported usage counters with zero', () => {
    const spec = parseFixtureFile(headless([{ promptIncludes: 'p', raw: 'x', usage: { inputTokens: 3, outputTokens: 4 } }]));
    expect(spec.fakeCore!.headless[0]!.answers[0]!.usage).toEqual({
      inputTokens: 3, outputTokens: 4, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7, model: null, estimated: false,
    });
  });
  it.each([
    ['unknown fakeCore key', { tickets: [ticket], fakeCore: { headless: [], interactive: [] } }],
    ['missing headless', { tickets: [ticket], fakeCore: {} }],
    ['non-array headless', { tickets: [ticket], fakeCore: { headless: {} } }],
    ['unknown rule key', headless([{ promptIncludes: 'p', raw: 'x', regex: 'y' }])],
    ['empty promptIncludes', headless([{ promptIncludes: '', raw: 'x' }])],
    ['rule without an answer', headless([{ promptIncludes: 'p' }])],
    ['raw and answers together', headless([{ promptIncludes: 'p', raw: 'x', answers: [{ raw: 'y' }] }])],
    ['empty answers list', headless([{ promptIncludes: 'p', answers: [] }])],
    ['non-string raw', headless([{ promptIncludes: 'p', raw: 1 }])],
    ['unknown answer key', headless([{ promptIncludes: 'p', answers: [{ raw: 'x', extra: 1 }] }])],
    ['bad usage key', headless([{ promptIncludes: 'p', raw: 'x', usage: { inputTokens: 1, outputTokens: 1, cost: 2 } }])],
    ['negative usage', headless([{ promptIncludes: 'p', raw: 'x', usage: { inputTokens: -1, outputTokens: 1 } }])],
  ])('refuses %s', (_n, input) => {
    expect(() => parseFixtureFile(input)).toThrow();
  });
});

describe('shipped samples', () => {
  const sample = (f: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'uat-host', 'samples', f), 'utf8'));
  it('stranded-uat fixture is a valid fixture file: uat running, no run rows', () => {
    const [t] = parseFixtureFile(sample('stranded-uat.fixture.json')).tickets;
    expect(t).toMatchObject({ stageCurrent: 'uat', worktree: true });
    expect(t?.rows).toBeUndefined();
  });
  it('stranded-uat steps parse and include a restart', () => {
    expect(parseSteps(sample('stranded-uat.steps.json')).map((s) => s.type)).toContain('restart');
  });
  it('fake-core samples are valid fixture files with the scripted answers they name', () => {
    const review = parseFixtureFile(sample('fake-core-review.fixture.json'));
    expect(review.tickets[0]).toMatchObject({ stageCurrent: 'review', worktree: true });
    expect(JSON.parse(review.fakeCore!.headless[0]!.answers[0]!.raw)[0]).toMatchObject({ severity: 'high' });
    const reformat = parseFixtureFile(sample('fake-core-reformat.fixture.json')).fakeCore!.headless[0]!;
    expect(reformat.promptIncludes).toBe('Put any probe scripts or scratch files under');
    expect(reformat.answers).toHaveLength(2);
    expect(() => JSON.parse(reformat.answers[0]!.raw)).toThrow();
    expect(() => JSON.parse(reformat.answers[1]!.raw)).not.toThrow();
  });
  it('fake-core forms sample holds a clean, a fenced, a narrated and an empty answer', () => {
    const rules = parseFixtureFile(sample('fake-core-forms.fixture.json')).fakeCore!.headless;
    const raws = rules.map((r) => r.answers[0]!.raw);
    expect(raws[0]!.startsWith('[')).toBe(true);
    expect(raws[1]!.startsWith('```json')).toBe(true);
    expect(raws[2]!.startsWith('[')).toBe(false);
    expect(raws[2]!).toContain('[{');
    expect(raws[3]).toBe('');
  });
  it('fake-core steps samples parse', () => {
    expect(parseSteps(sample('fake-core-review.steps.json')).map((s) => s.type)).toContain('read');
    expect(parseSteps(sample('fake-core-reformat.steps.json')).map((s) => s.type)).toContain('snapshot');
  });
});
