import { describe, it, expect } from 'vitest';
import { scopeReviewFindings, scopeUatFindings } from './findingScope.js';
import type { Finding } from '../store/reviewFindings.js';
import type { UatFinding } from '../store/uatFindings.js';
import type { ProcessRun } from '../store/processRuns.js';

function makeRun(overrides: Partial<ProcessRun> & { id: number }): ProcessRun {
  return {
    ticketId: 1,
    stageKey: 'review',
    processId: 'review',
    attempt: 1,
    stageRunId: null,
    agentName: null,
    provider: null,
    model: null,
    pid: null,
    status: 'passed',
    resultKind: 'validated',
    artifactPath: null,
    promptTelemetry: null,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:01:00.000Z',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> & { id: number }): Finding {
  return {
    ticketId: 1,
    attempt: 1,
    runAt: '2026-07-20T12:00:00.000Z',
    processRunId: null,
    severity: 'high',
    repo: '',
    file: null,
    line: null,
    title: 'finding',
    detail: 'detail',
    source: 'agent',
    createdAt: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

function makeUatFinding(overrides: Partial<UatFinding> & { id: number }): UatFinding {
  return {
    ticketId: 1,
    processRunId: 1,
    repo: null,
    severity: 'high',
    title: 'observation',
    filePath: null,
    line: null,
    createdAt: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('scopeReviewFindings', () => {
  it('no run, legacy rows — returns only the newer runAt group', () => {
    const findings = [
      makeFinding({ id: 1, processRunId: null, runAt: '2026-07-20T11:00:00.000Z' }),
      makeFinding({ id: 2, processRunId: null, runAt: '2026-07-20T12:00:00.000Z' }),
      makeFinding({ id: 3, processRunId: null, runAt: '2026-07-20T12:00:00.000Z' }),
    ];
    const result = scopeReviewFindings(findings, undefined);
    expect(result).toEqual([findings[1], findings[2]]);
  });

  it('no run, no findings — returns []', () => {
    expect(scopeReviewFindings([], undefined)).toEqual([]);
  });

  it('run with own findings — returns exactly those', () => {
    const run = makeRun({ id: 2 });
    const findings = [
      makeFinding({ id: 1, processRunId: 1, runAt: '2026-07-20T11:00:00.000Z' }),
      makeFinding({ id: 2, processRunId: 2, runAt: '2026-07-20T12:00:00.000Z' }),
      makeFinding({ id: 3, processRunId: 2, runAt: '2026-07-20T12:01:00.000Z' }),
    ];
    const result = scopeReviewFindings(findings, run);
    expect(result).toEqual([findings[1], findings[2]]);
  });

  it('a running re-review renders no findings from the round it replaced', () => {
    const run = makeRun({ id: 2, status: 'running', resultKind: null, endedAt: null });
    const findings = [
      makeFinding({ id: 1, processRunId: 1, runAt: '2026-07-20T11:00:00.000Z' }),
    ];
    const result = scopeReviewFindings(findings, run);
    expect(result).toEqual([]);
  });

  it('in-flight run, no own findings, no other findings — returns []', () => {
    const run = makeRun({ id: 1, status: 'running', resultKind: null, endedAt: null });
    expect(scopeReviewFindings([], run)).toEqual([]);
  });

  it('finished run, no own findings, previous attributed findings — returns []', () => {
    const run = makeRun({ id: 2, resultKind: 'validated' });
    const findings = [
      makeFinding({ id: 1, processRunId: 1, runAt: '2026-07-20T11:00:00.000Z' }),
    ];
    const result = scopeReviewFindings(findings, run);
    expect(result).toEqual([]);
  });

  it('finished run, no own findings, legacy findings — returns legacy batch', () => {
    const run = makeRun({ id: 2, resultKind: 'validated' });
    const findings = [
      makeFinding({ id: 1, processRunId: null, runAt: '2026-07-20T11:00:00.000Z' }),
      makeFinding({ id: 2, processRunId: null, runAt: '2026-07-20T12:00:00.000Z' }),
    ];
    const result = scopeReviewFindings(findings, run);
    expect(result).toEqual([findings[1]]);
  });

  it('order is preserved — findings come back in input order', () => {
    const run = makeRun({ id: 1 });
    const findings = [
      makeFinding({ id: 3, processRunId: 1, severity: 'low', runAt: '2026-07-20T12:02:00.000Z' }),
      makeFinding({ id: 1, processRunId: 1, severity: 'critical', runAt: '2026-07-20T12:00:00.000Z' }),
      makeFinding({ id: 2, processRunId: 1, severity: 'medium', runAt: '2026-07-20T12:01:00.000Z' }),
    ];
    const result = scopeReviewFindings(findings, run);
    expect(result).toEqual(findings);
  });
});

describe('scopeUatFindings', () => {
  it('no run — returns [] even when observations exist', () => {
    const findings = [
      makeUatFinding({ id: 1, processRunId: 1 }),
    ];
    expect(scopeUatFindings(findings, undefined)).toEqual([]);
  });

  it('run with own observations — returns only those', () => {
    const run = makeRun({ id: 2, processId: 'tester' });
    const findings = [
      makeUatFinding({ id: 1, processRunId: 1 }),
      makeUatFinding({ id: 2, processRunId: 2 }),
    ];
    const result = scopeUatFindings(findings, run);
    expect(result).toEqual([findings[1]]);
  });

  it('run with none of its own, a previous run present — returns []', () => {
    const run = makeRun({ id: 2, processId: 'tester' });
    const findings = [
      makeUatFinding({ id: 1, processRunId: 1 }),
    ];
    const result = scopeUatFindings(findings, run);
    expect(result).toEqual([]);
  });
});
