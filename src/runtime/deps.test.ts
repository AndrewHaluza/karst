import { describe, it, expect } from 'vitest';
import { checkDependencies, GIT_DEPENDENCY, type RequiredDependency } from './deps.js';

const AGENT: RequiredDependency = {
  binary: 'claude',
  label: 'Claude Code',
  install: 'Install Claude Code: https://docs.claude.com/claude-code',
};

describe('checkDependencies', () => {
  it('returns nothing missing when every binary probes present', () => {
    const missing = checkDependencies([GIT_DEPENDENCY, AGENT], () => true);
    expect(missing).toEqual([]);
  });

  it('returns the dependencies whose binary is absent', () => {
    const missing = checkDependencies([GIT_DEPENDENCY, AGENT], (bin) => bin === 'git');
    expect(missing).toEqual([AGENT]);
  });

  it('returns all when nothing is present, preserving order', () => {
    const missing = checkDependencies([GIT_DEPENDENCY, AGENT], () => false);
    expect(missing.map((d) => d.binary)).toEqual(['git', 'claude']);
  });
});
