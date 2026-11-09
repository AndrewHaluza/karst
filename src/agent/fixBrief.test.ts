import { describe, it, expect } from 'vitest';
import { REVIEW_SWEEP_RULE } from './fixBrief.js';
import type { Finding } from '../store/reviewFindings.js';
import type { GateRun } from '../store/gateRuns.js';
import type { PrFeedbackRow } from '../store/prFeedback.js';
import {
  FIX_GATE_LIST_HEADER,
  FIX_GATE_LIST_MAX,
  hasLinkedPrototype,
  PROTOTYPE_REGION_CHECKLIST_RULE,
  renderFixBrief,
} from './fixBrief.js';

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

  describe('review sweep rule', () => {
    it('adds the sweep rule to a failed review gate brief', () => {
      const brief = renderFixBrief('PROJ-9', [{ stageKey: 'review', status: 'failed' }]);
      expect(brief).toContain(REVIEW_SWEEP_RULE);
      expect(REVIEW_SWEEP_RULE).toContain('commit body');
    });

    it('keeps the rule out of a failed uat gate brief and out of PR feedback', () => {
      const uat = renderFixBrief('PROJ-9', [{ stageKey: 'uat', status: 'failed' }]);
      expect(uat).not.toContain(REVIEW_SWEEP_RULE);
      const ship = renderFixBrief('PROJ-9', [{ stageKey: 'ship', status: 'failed' }], [], [], [
        {
          repo: 'r', path: 'a.ts', line: 1, originalLine: 1, body: 'x',
          author: { login: 'bob', association: '' },
        } as never,
      ]);
      expect(ship).not.toContain(REVIEW_SWEEP_RULE);
    });
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

  it('never hands the fix agent the advisory coverage record as a finding', () => {
    const brief = renderFixBrief(
      'PROJ-7',
      [{ stageKey: 'review', status: 'failed', verdict: 'review findings: 1 critical' }],
      [
        finding({ severity: 'critical', title: 'SQL injection' }),
        finding({ severity: 'info', title: 'COVERAGE (reported): PASS — checked the diff' }),
      ],
    );
    expect(brief).toContain('SQL injection');
    expect(brief).not.toContain('COVERAGE');
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

  it('names both ways out of a docs-gate BLOCK', () => {
    const brief = renderFixBrief(
      'PROJ-12',
      [{ stageKey: 'uat', status: 'failed', verdict: 'gates failed: docs:gate' }],
      [],
      [gate({ stageKey: 'uat', gateName: 'docs:gate', exitCode: 1, summary: '✗ BLOCK diff changes resolveAdapter in src/agent/registry.ts (covered by @arch:UATHOST-00)' })],
    );
    expect(brief).toContain('Edit the block and commit the edit');
    expect(brief).toContain('karst arch cite @arch:KEY --why');
  });

  it('adds no cite hint for other failures', () => {
    const brief = renderFixBrief(
      'PROJ-13',
      [{ stageKey: 'uat', status: 'failed' }],
      [],
      [gate({ stageKey: 'uat', gateName: 'lint', exitCode: 1, summary: 'x.ts:1 bad' })],
    );
    expect(brief).not.toContain('arch cite');
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

  // Array position must not decide which gate the brief is about. `review` is
  // FIRST here and `ship` failed LATER — the brief follows the clock.
  it('names the gate that failed last, not the first in the array', () => {
    const brief = renderFixBrief('PROJ-9', [
      {
        stageKey: 'review',
        status: 'failed',
        endedAt: '2026-01-01T00:00:00.000Z',
        verdict: 'review says no',
      },
      {
        stageKey: 'ship',
        status: 'failed',
        endedAt: '2026-01-02T00:00:00.000Z',
        verdict: 'ship says no',
      },
    ]);
    expect(brief).toContain('ship gate failed');
    expect(brief).toContain('ship says no');
    expect(brief).not.toContain('review gate failed');
    expect(brief).not.toContain('review says no');
  });

  // The mirror image, with the array order reversed too: the answer tracks
  // `endedAt` in both directions, not the position of either row.
  it('names review when review is the gate that failed last', () => {
    const brief = renderFixBrief('PROJ-10', [
      {
        stageKey: 'ship',
        status: 'failed',
        endedAt: '2026-01-01T00:00:00.000Z',
        verdict: 'ship says no',
      },
      {
        stageKey: 'review',
        status: 'failed',
        endedAt: '2026-01-02T00:00:00.000Z',
        verdict: 'review says no',
      },
    ]);
    expect(brief).toContain('review gate failed');
    expect(brief).toContain('review says no');
    expect(brief).not.toContain('ship gate failed');
  });

  describe('linked prototype checklist rule (@ui:UI-R39-REJECT)', () => {
    it('detects a linked prototype in title, description, or brief', () => {
      expect(hasLinkedPrototype({ title: 'feat: add prototype support' })).toBe(true);
      expect(hasLinkedPrototype({ description: 'see docs/design/ticket-form-b-prime.html' })).toBe(true);
      expect(hasLinkedPrototype({ brief: 'The prototype is binding per UI-R39' })).toBe(true);
      expect(hasLinkedPrototype({ title: 'plain backend task', description: 'no UI here' })).toBe(false);
    });

    it('adds the per-region checklist instruction when hasPrototype is true', () => {
      const brief = renderFixBrief(
        'PROJ-30',
        [{ stageKey: 'uat', status: 'failed', verdict: 'exit 1' }],
        [],
        [],
        [],
        { hasPrototype: true },
      );
      expect(brief).toContain(PROTOTYPE_REGION_CHECKLIST_RULE);
    });

    it('omits the checklist instruction when hasPrototype is false or omitted', () => {
      const brief = renderFixBrief(
        'PROJ-31',
        [{ stageKey: 'uat', status: 'failed', verdict: 'exit 1' }],
      );
      expect(brief).not.toContain('@ui:UI-R39-REJECT');
    });

    it('does not duplicate the instruction if gate.verdict already includes it', () => {
      const brief = renderFixBrief(
        'PROJ-32',
        [{ stageKey: 'uat', status: 'failed', verdict: `rejected\n${PROTOTYPE_REGION_CHECKLIST_RULE}` }],
        [],
        [],
        [],
        { hasPrototype: true },
      );
      const occurrences = (brief ?? '').split(PROTOTYPE_REGION_CHECKLIST_RULE).length - 1;
      expect(occurrences).toBe(1);
    });
  });

  describe('gate list before the marker', () => {
    const uatBatch = (over: Partial<GateRun>[]): GateRun[] =>
      over.map((o, i) => gate({ id: i + 1, stageKey: 'uat', ...o }));

    it('lists the passed gates of the latest batch for a review-failed brief', () => {
      const runs = uatBatch([
        { gateName: 'unit (web)', exitCode: 0, command: 'npm', args: ['run', '-s', 'test'] },
        { gateName: 'docs (web)', exitCode: 0, command: 'npm', args: ['run', '-s', 'docs:check'] },
      ]);
      const brief = renderFixBrief('P-1', [{ stageKey: 'review', status: 'failed' }], [], runs);
      expect(brief).toContain(FIX_GATE_LIST_HEADER);
      expect(brief).toContain('- unit (web): npm run -s test');
      expect(brief).toContain('- docs (web): npm run -s docs:check');
    });

    it('lists failing and passed gates of the latest batch only', () => {
      const runs = [
        gate({ id: 1, stageKey: 'uat', runAt: '2026-08-01T09:00:00.000Z', gateName: 'old', exitCode: 0 }),
        gate({ id: 2, stageKey: 'uat', runAt: '2026-08-01T10:00:00.000Z', gateName: 'fails', exitCode: 1 }),
        gate({ id: 3, stageKey: 'uat', runAt: '2026-08-01T10:00:00.000Z', gateName: 'passes', exitCode: 0 }),
      ];
      const brief = renderFixBrief('P-1', [{ stageKey: 'uat', status: 'failed' }], [], runs) ?? '';
      expect(brief).toContain('- fails: npm run lint');
      expect(brief).toContain('- passes: npm run lint');
      expect(brief).not.toContain('- old:');
    });

    it('does not list a skipped gate', () => {
      const runs = uatBatch([{ gateName: 'off', exitCode: null, skipped: true }, { gateName: 'on', exitCode: 0 }]);
      const brief = renderFixBrief('P-1', [{ stageKey: 'uat', status: 'failed' }], [], runs) ?? '';
      expect(brief).toContain('- on:');
      expect(brief).not.toContain('- off:');
    });

    it('does not list the non-gate changes row', () => {
      const runs = [
        gate({ id: 1, stageKey: 'review', gateName: 'changes', exitCode: 0, command: 'git', args: ['diff'] }),
        gate({ id: 2, stageKey: 'review', gateName: 'lint', exitCode: 0 }),
      ];
      const brief = renderFixBrief('P-1', [{ stageKey: 'review', status: 'failed' }], [], runs) ?? '';
      expect(brief).toContain('- lint:');
      expect(brief).not.toContain('- changes:');
    });

    it('does not list a row with no command', () => {
      const runs = uatBatch([
        { gateName: 'legacy', exitCode: 0, command: null, args: null },
        { gateName: 'on', exitCode: 0 },
      ]);
      const brief = renderFixBrief('P-1', [{ stageKey: 'uat', status: 'failed' }], [], runs) ?? '';
      expect(brief).toContain('- on:');
      expect(brief).not.toContain('- legacy:');
    });

    it('lists the review batch, not the UAT batch, for a review-failed brief with review rows', () => {
      const runs = [
        gate({ id: 1, stageKey: 'uat', runAt: '2026-08-01T11:00:00.000Z', gateName: 'uat-gate', exitCode: 0 }),
        gate({ id: 2, stageKey: 'review', runAt: '2026-08-01T10:00:00.000Z', gateName: 'review-gate', exitCode: 0 }),
      ];
      const brief = renderFixBrief('P-1', [{ stageKey: 'review', status: 'failed' }], [], runs) ?? '';
      expect(brief).toContain('- review-gate:');
      expect(brief).not.toContain('- uat-gate:');
    });

    it('omits the section when no gate run exists', () => {
      const brief = renderFixBrief('P-1', [{ stageKey: 'uat', status: 'failed' }]);
      expect(brief).not.toContain(FIX_GATE_LIST_HEADER);
    });

    it('omits the section when every gate of the batch is skipped', () => {
      const runs = uatBatch([{ gateName: 'off', exitCode: null, skipped: true }]);
      const brief = renderFixBrief('P-1', [{ stageKey: 'uat', status: 'failed' }], [], runs);
      expect(brief).not.toContain(FIX_GATE_LIST_HEADER);
    });

    it('omits the section from the PR-feedback brief', () => {
      const runs = uatBatch([{ gateName: 'unit', exitCode: 0 }]);
      const brief = renderFixBrief('P-1', [{ stageKey: 'ship', status: 'failed' }], [], runs, [feedback()]);
      expect(brief).not.toContain(FIX_GATE_LIST_HEADER);
    });

    it('bounds the list and says how many lines were cut', () => {
      const runs = uatBatch(
        Array.from({ length: FIX_GATE_LIST_MAX + 3 }, (_, i) => ({ gateName: `g${i}`, exitCode: 0 })),
      );
      const brief = renderFixBrief('P-1', [{ stageKey: 'uat', status: 'failed' }], [], runs) ?? '';
      expect(brief).toContain(`- g${FIX_GATE_LIST_MAX - 1}:`);
      expect(brief).not.toContain(`- g${FIX_GATE_LIST_MAX}:`);
      expect(brief).toContain('3 more gates not shown');
    });
  });
});
