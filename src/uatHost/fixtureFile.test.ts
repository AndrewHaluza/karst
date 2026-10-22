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
});
