import { describe, it, expect } from 'vitest';
import type { Finding } from '../store/reviewFindings.js';
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
});
