import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, RunHeadlessOpts } from '../agent/adapter.js';
import { analyzeTicket } from './classify/analyze.js';
import { generateIntent } from './classify/intent.js';
import { runAlignment } from './artifacts/alignment.js';

const VALID_INTENT =
  '## Goal\nUsers can archive a ticket.\n\n## Scenarios\n- Given an open ticket, when the user clicks Archive, then it leaves the board';

function recorder(raw: string): { adapter: AgentAdapter; seen: RunHeadlessOpts[] } {
  const seen: RunHeadlessOpts[] = [];
  const adapter: AgentAdapter = {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    async runHeadless(o) {
      seen.push(o);
      return { sessionId: 's', verdict: null, raw };
    },
  };
  return { adapter, seen };
}

describe('minimalContext lanes', () => {
  it('ticket-intent sets minimalContext', async () => {
    const { adapter, seen } = recorder(VALID_INTENT);
    await generateIntent(adapter, { brief: 'archive a ticket', title: 'Archive' } as never);
    expect(seen[0]?.minimalContext).toBe(true);
  });

  it('ticket-analysis (classify) sets minimalContext and parses a flagged-run answer', async () => {
    const raw =
      'Here is the result:\n{"prompt":"## Goal\\nAdd X\\n\\n## Steps\\n1. do it","approach":"gsd","repos":["backend"],"reason":"r","type":"fix"}';
    const { adapter, seen } = recorder(raw);
    const r = await analyzeTicket(adapter, {
      brief: 'b',
      services: [{ name: 'backend', description: 'api', signals: [], score: 1 }],
      approaches: [{ id: 'gsd', label: 'GSD', description: 'small' }],
    });
    expect(seen[0]?.minimalContext).toBe(true);
    expect(r.prompt).toContain('## Steps');
    expect(r.approachId).toBe('gsd');
    expect(r.type).toBe('fix');
    expect(r.degraded).toBe(false);
  });

  it('artifact-alignment sets minimalContext and still returns structured findings', async () => {
    const { adapter, seen } = recorder('[{"severity":"high","title":"Scenario 2 not planned","detail":"d"}]');
    const r = await runAlignment(
      { adapter },
      { ticketId: 1, edge: 'intent-plan', parentText: 'I', childText: 'P' },
    );
    expect(seen[0]?.minimalContext).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.failed).toBe(false);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('minimalContext is set by the four lanes only', () => {
  it('no other source file passes minimalContext: true to a headless call', () => {
    const setters = sources('src')
      .filter((f) => /minimalContext:\s*true/.test(readFileSync(f, 'utf8')))
      .sort();
    expect(setters).toEqual([
      'src/workflow/artifacts/alignment.ts',
      'src/workflow/classify/analyze.ts',
      'src/workflow/classify/intent.ts',
      'src/workflow/stages/shipDescription.ts',
    ]);
  });

  it('analyze.ts sets it on the classify call only (improve lives elsewhere)', () => {
    const src = readFileSync('src/workflow/classify/analyze.ts', 'utf8');
    expect(src.match(/minimalContext:\s*true/g)).toHaveLength(1);
  });
});
