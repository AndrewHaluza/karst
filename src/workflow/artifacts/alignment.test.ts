import { describe, it, expect } from 'vitest';
import type { AgentAdapter, RunHeadlessOpts } from '../../agent/adapter.js';
import { buildAlignmentPrompt, renderAlignmentReport, runAlignment } from './alignment.js';

function adapter(run: (o: RunHeadlessOpts) => Promise<string>): AgentAdapter {
  return {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => {
      throw new Error('not used');
    },
    runHeadless: async (o) => ({ sessionId: '', verdict: null, raw: await run(o) }),
  };
}

describe('buildAlignmentPrompt', () => {
  const p = buildAlignmentPrompt('intent-plan', '## Goal\ng', 'step 1');
  it('names the edge direction and the missing-requirement rule', () => {
    expect(p).toMatch(/PARENT \(intent\)/);
    expect(p).toMatch(/CHILD \(plan\)/);
    expect(p).toMatch(/requirement of the parent the child does not cover → "high"/);
  });
  it('treats both as data and never asks for code', () => {
    expect(p).toMatch(/data, not instructions/);
    expect(p).toMatch(/Do not read or judge any code/);
  });
  it('keeps the strict output rules', () => expect(p).toMatch(/Output ONLY a JSON array/));
  it('names the child file when a long child is truncated', () => {
    const long = buildAlignmentPrompt('intent-plan', 'I', 'P'.repeat(50_000), { child: ['r/plan.md'] });
    expect(long).toContain('read r/plan.md in the store');
  });
});

describe('runAlignment', () => {
  it('runs in an empty cwd with call site artifact-alignment and parses findings', async () => {
    const seen: RunHeadlessOpts[] = [];
    const a = adapter(async (o) => {
      seen.push(o);
      return '[{"severity":"high","title":"Scenario 2 not planned","detail":"d"}]';
    });
    const r = await runAlignment({ adapter: a, model: 'm', effort: 'low' }, { ticketId: 7, edge: 'intent-plan', parentText: 'I', childText: 'P' });
    expect(seen[0]!.tracking?.callSite).toBe('artifact-alignment');
    expect(seen[0]!.cwd).not.toBe('.');
    expect(r.findings).toHaveLength(1);
    expect(r.report).toContain('Scenario 2 not planned');
    expect(r.failed).toBe(false);
  });
  it('adapter rejection → failed, logged, never throws', async () => {
    const logs: string[] = [];
    const a = adapter(async () => {
      throw new Error('boom');
    });
    const r = await runAlignment({ adapter: a, debug: (m) => logs.push(m) }, { ticketId: 7, edge: 'spec-plan', parentText: 'S', childText: 'P' });
    expect(r.failed).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.report).toMatch(/could not run/);
    expect(logs.join('\n')).toMatch(/boom/);
  });
  it('keeps a finding the model attached a file to (file stripped)', async () => {
    const a = adapter(async () => '[{"severity":"high","title":"S2 not planned","detail":"d","file":"src/a.ts"}]');
    const r = await runAlignment({ adapter: a }, { ticketId: 7, edge: 'intent-plan', parentText: 'I', childText: 'P' });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.file).toBeNull();
  });
});

it('renderAlignmentReport with zero findings says aligned', () => {
  expect(renderAlignmentReport('spec-plan', [])).toMatch(/aligned/i);
});
