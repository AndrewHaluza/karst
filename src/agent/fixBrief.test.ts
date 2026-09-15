import { describe, it, expect } from 'vitest';
import type { Finding } from '../store/reviewFindings.js';
import type { GateRun } from '../store/gateRuns.js';
import type { PrFeedbackRow } from '../store/prFeedback.js';
import { renderFixBrief } from './fixBrief.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 1,
    ticketId: 1,
    attempt: 0,
    runAt: '2026-08-01T10:00:00.000Z',
    processRunId: null,
    severity: 'high',
    repo: '/web',
    file: null,
    line: null,
    title: 'a finding',
    detail: 'detail',
    source: 'agent',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

function gate(over: Partial<GateRun> = {}): GateRun {
  return {
    id: 1,
    ticketId: 1,
    stageKey: 'review',
    attempt: 0,
    runAt: '2026-08-01T10:00:00.000Z',
    gateName: 'lint (web)',
    exitCode: 1,
    startedAt: null,
    endedAt: null,
    repo: '/web',
    command: 'npm',
    args: ['run', 'lint'],
    skipped: false,
    stageRunId: null,
    summary: null,
    ...over,
  };
}

function feedback(over: Partial<PrFeedbackRow> = {}): PrFeedbackRow {
  return {
    id: 1,
    ticketId: 1,
    repo: 'frontend',
    prUrl: 'https://github.com/acme/repo/pull/1',
    kind: 'thread',
    upstreamKey: '1',
    threadNodeId: 'PRRT_1',
    upstreamUpdatedAt: null,
    state: null,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: null,
    startLine: null,
    originalLine: 10,
    originalCommitId: 'abc',
    subjectType: 'LINE',
    author: { login: 'alice', typeName: 'User', association: 'MEMBER' },
    body: 'please rename this',
    comments: [],
    firstSeenAt: '2026-08-01T10:00:00.000Z',
    lastSeenAt: '2026-08-01T10:00:00.000Z',
    absentAt: null,
    recoveryRoundId: 1,
    ...over,
  };
}

describe('renderFixBrief', () => {
  it('names the gate that failed, its reason and its log', () => {
    const brief = renderFixBrief('PROJ-3', [
      { stageKey: 'uat', status: 'passed' },
      {
        stageKey: 'review',
        status: 'failed',
        verdict: 'gates failed: lint, test',
        artifactPath: '/logs/review-ticket-3.log',
      },
      { stageKey: 'fix', status: 'running' },
    ]);
    expect(brief).toContain('PROJ-3');
    expect(brief).toContain('review gate failed');
    expect(brief).toContain('gates failed: lint, test');
    expect(brief).toContain('/logs/review-ticket-3.log');
  });

  it('still asks for a fix when the gate recorded no reason or log', () => {
    const brief = renderFixBrief('PROJ-4', [{ stageKey: 'uat', status: 'failed' }]);
    expect(brief).toContain('uat gate failed');
    expect(brief).not.toContain('undefined');
    expect(brief).not.toContain('null');
  });

  it('prefers the gate stages over any other failed stage', () => {
    const brief = renderFixBrief('PROJ-5', [
      { stageKey: 'scope', status: 'failed', verdict: 'scope blew up' },
      { stageKey: 'uat', status: 'failed', verdict: 'exit 1' },
    ]);
    expect(brief).toContain('uat gate failed');
    expect(brief).not.toContain('scope blew up');
  });

  it('returns null when no gate failed — there is nothing to fix', () => {
    expect(renderFixBrief('PROJ-6', [{ stageKey: 'uat', status: 'passed' }])).toBeNull();
  });

  it('names review findings, with their severity and location, when the failing gate is review', () => {
    const brief = renderFixBrief(
      'PROJ-7',
      [{ stageKey: 'review', status: 'failed', verdict: 'review findings: 1 critical' }],
      [
        finding({ severity: 'critical', title: 'SQL injection', file: 'src/db.ts', line: 42 }),
        finding({ severity: 'low', title: 'unused import' }),
      ],
    );
    expect(brief).toContain('[critical] SQL injection (src/db.ts:42)');
    expect(brief).toContain('[low] unused import');
  });

  it('says nothing about findings when there are none', () => {
    const brief = renderFixBrief('PROJ-8', [{ stageKey: 'review', status: 'failed' }], []);
    expect(brief).not.toContain('findings');
  });

  it('never attributes a review finding to a uat gate failure', () => {
    // Findings are review-only evidence; a stale batch from a PRIOR review run
    // must not be read onto an unrelated uat failure.
    const brief = renderFixBrief(
      'PROJ-9',
      [{ stageKey: 'uat', status: 'failed', verdict: 'exit 1' }],
      [finding({ severity: 'critical', title: 'stale finding' })],
    );
    expect(brief).not.toContain('stale finding');
  });

  it('includes the failing gates output excerpts, so the fix is pointed at the defect', () => {
    const brief = renderFixBrief(
      'PROJ-10',
      [{ stageKey: 'review', status: 'failed', verdict: 'gates failed: lint (web)' }],
      [],
      [
        gate({
          gateName: 'lint (web)',
          exitCode: 1,
          summary: 'src/pages/index.vue:23:9 Replace `x` with `y`',
        }),
      ],
    );
    expect(brief).toContain('The failing gates reported:');
    expect(brief).toContain('- lint (web) (exit 1)');
    expect(brief).toContain('src/pages/index.vue:23:9 Replace `x` with `y`');
  });

  it('lists only the latest batch of failing gates, never a superseded run', () => {
    const brief = renderFixBrief(
      'PROJ-11',
      [{ stageKey: 'review', status: 'failed', verdict: 'gates failed: lint (web)' }],
      [],
      [
        gate({
          runAt: '2026-08-01T09:00:00.000Z',
          gateName: 'lint (web)',
          summary: 'stale failure from an earlier attempt',
        }),
        gate({
          runAt: '2026-08-01T10:00:00.000Z',
          gateName: 'lint (web)',
          summary: 'the current failure',
        }),
        gate({ runAt: '2026-08-01T10:00:00.000Z', gateName: 'typecheck (web)', exitCode: 0 }),
      ],
    );
    expect(brief).toContain('the current failure');
    expect(brief).not.toContain('stale failure');
  });

  it('never attributes a failing gate to a different stage than the one that failed', () => {
    // The ticket is parked at fix because review failed; a uat gate from the
    // ticket's history must not read as part of this failure.
    const brief = renderFixBrief(
      'PROJ-12',
      [{ stageKey: 'review', status: 'failed', verdict: 'gates failed: lint (web)' }],
      [],
      [gate({ stageKey: 'uat', gateName: 'test (web)', exitCode: 1, summary: 'uat broke' })],
    );
    expect(brief).not.toContain('The failing gates reported:');
    expect(brief).not.toContain('uat broke');
  });

  it('says nothing about gate output when none of the failing gates recorded a summary', () => {
    const brief = renderFixBrief(
      'PROJ-13',
      [{ stageKey: 'review', status: 'failed', verdict: 'gates failed: lint (web)' }],
      [],
      [gate({ gateName: 'lint (web)', exitCode: 1, summary: null })],
    );
    expect(brief).not.toContain('The failing gates reported:');
  });

  describe('ship-sourced PR feedback', () => {
    const shipBrief = (label: string, prFeedback: PrFeedbackRow[]) =>
      renderFixBrief(label, [{ stageKey: 'ship', status: 'failed' }], [], [], prFeedback);

    it('addresses the reviewers, with repo, location, author and body', () => {
      const brief = shipBrief('PROJ-14', [
        feedback({ repo: 'frontend', path: 'src/a.ts', originalLine: 42, body: 'please rename this' }),
      ]);
      expect(brief).toContain('Reviewers requested changes on the pull request for ticket PROJ-14');
      expect(brief).toContain('The review team asked for these changes:');
      expect(brief).toContain('- frontend src/a.ts:42');
      expect(brief).toContain('asked by alice (MEMBER)');
      expect(brief).toContain('    please rename this');
      expect(brief).toContain('Do not resolve the conversations yourself');
    });

    it('uses originalLine even when line holds a different value', () => {
      const brief = shipBrief('PROJ-15', [feedback({ path: 'src/a.ts', line: 99, originalLine: 7 })]);
      expect(brief).toContain('src/a.ts:7');
      expect(brief).not.toContain('src/a.ts:99');
    });

    it('renders a general comment for a null path, never a bare colon', () => {
      const brief = shipBrief('PROJ-16', [feedback({ path: null, originalLine: null })]);
      expect(brief).toContain('- frontend (general comment)');
    });

    it('renders a file-level comment with the path only', () => {
      const brief = shipBrief('PROJ-17', [feedback({ path: 'src/a.ts', originalLine: null })]);
      expect(brief).toContain('- frontend src/a.ts');
    });

    it('indents a multi-line body line by line', () => {
      const brief = shipBrief('PROJ-18', [feedback({ body: 'line one\nline two' })]);
      expect(brief).toContain('    line one\n    line two');
    });

    it('omits the asked-by line when the author login is empty', () => {
      const brief = shipBrief('PROJ-19', [
        feedback({ author: { login: '', typeName: '', association: '' } }),
      ]);
      expect(brief).not.toContain('asked by');
    });

    it('falls back to the generic wording for a failed ship row with no feedback', () => {
      // A ship-saga failure with no adopted feedback is not a review ask —
      // "Address every point below" would name points that are not there.
      const brief = renderFixBrief('PROJ-20', [{ stageKey: 'ship', status: 'failed' }]);
      expect(brief).toContain('The ship gate failed');
      expect(brief).not.toContain('Reviewers requested changes');
      expect(brief).not.toContain('The review team asked for these changes:');
    });

    it('never renders the ship block for a uat or review failure', () => {
      const brief = renderFixBrief(
        'PROJ-21',
        [{ stageKey: 'review', status: 'failed', verdict: 'gates failed: lint' }],
        [],
        [],
        [feedback()],
      );
      expect(brief).not.toContain('The review team asked for these changes:');
      expect(brief).not.toContain('Reviewers requested changes');
    });
  });
});
