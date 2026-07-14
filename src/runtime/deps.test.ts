import { describe, it, expect } from 'vitest';
import { checkDependencies, GIT_DEPENDENCY, agentDependency, AGENT_CLI_DEPENDENCIES, type RequiredDependency } from './deps.js';
import { resolveAdapter } from '../agent/registry.js';

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

describe('agentDependency', () => {
  it('returns the confirmed claude entry', () => {
    const dep = agentDependency('claude');
    expect(dep.binary).toBe('claude');
    expect(dep.label).toBe('the Claude Code CLI');
    expect(dep.install).toMatch(/claude\.com\/claude-code/);
    expect(AGENT_CLI_DEPENDENCIES.claude).toEqual(dep);
  });

  it('falls back to a generic entry for a provider without confirmed docs', () => {
    const dep = agentDependency('codex');
    expect(dep.binary).toBe('codex');
    expect(dep.label).toBe('the codex CLI');
    expect(dep.install).toContain("'codex' is on your PATH");
  });

  // Guard against binary-name drift: the dependency check must probe the SAME
  // binary the launcher spawns, else the checklist reports a false present/missing.
  it('probes the same binary the claude adapter launches', () => {
    expect(agentDependency('claude').binary).toBe(resolveAdapter('claude').requiredBinary);
  });
});
