import { describe, expect, it } from 'vitest';
import { buildScopeBlock } from './agentScope.js';

describe('buildScopeBlock', () => {
  it('names the exact diff range when the base ref is known', () => {
    const text = buildScopeBlock('review', { baseRef: 'develop' }).join('\n');
    expect(text).toContain('`git diff origin/develop...HEAD`');
    expect(text).toContain('`git diff develop...HEAD`');
    // Each command is its own code span — a nested pair renders as a mangled
    // range the agent then has to guess at, which is what this block removes.
    for (const line of buildScopeBlock('review', { baseRef: 'develop' })) {
      expect((line.match(/`/g) ?? []).length % 2).toBe(0);
    }
  });

  it('never interpolates a missing base ref', () => {
    const text = buildScopeBlock('test').join('\n');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('origin/null');
  });

  it('forbids the repo-wide reconnaissance both lanes were paying for', () => {
    const text = buildScopeBlock('review', { baseRef: 'main' }).join('\n');
    expect(text).toContain('git worktree list');
    expect(text).toContain('orchestration tool that launched you');
    expect(text).toMatch(/Do NOT run repository-wide reconnaissance/);
    expect(text).toMatch(/Do NOT re-derive/i);
  });

  it('names the gates that already passed so the agent does not re-run them', () => {
    const text = buildScopeBlock('test', {
      baseRef: 'main',
      gatesPassed: ['test:unit (extention)', 'test:e2e (extention)'],
    }).join('\n');
    expect(text).toContain('test:unit (extention), test:e2e (extention)');
    expect(text).toContain('Do NOT re-run them');
  });

  it('omits the gate line entirely when no gate is named', () => {
    const text = buildScopeBlock('test', { baseRef: 'main' }).join('\n');
    expect(text).not.toContain('already ran and PASSED');
  });
});
