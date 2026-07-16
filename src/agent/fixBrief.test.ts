import { describe, it, expect } from 'vitest';
import { renderFixBrief } from './fixBrief.js';

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
});
