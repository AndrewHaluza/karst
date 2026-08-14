import { describe, it, expect } from 'vitest';
import { detectInertKeys } from './inertKeys.js';

describe('detectInertKeys', () => {
  it('says nothing about a manifest that declares no inert key', () => {
    expect(detectInertKeys({ host: '127.0.0.1', uat: { maxFixAttempts: 5 } })).toEqual([]);
  });

  it('names inert uat keys the author actually declared', () => {
    const notices = detectInertKeys({
      uat: { maxFixAttempts: 3, secrets: ['STRIPE_KEY'], origins: ['https://a.test'] },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('uat.secrets');
    expect(notices[0]).toContain('uat.origins');
    expect(notices[0]).toContain('not yet active');
    // Wired keys are never named.
    expect(notices[0]).not.toContain('maxFixAttempts');
  });

  it('does not fire for an absent uat block', () => {
    expect(detectInertKeys({ host: 'x' })).toEqual([]);
  });

  it('reports per-repository uat overrides', () => {
    const notices = detectInertKeys({
      uat: { repositories: { api: { env: { A: 'b' }, gates: [] } } },
    });
    expect(notices[0]).toContain('uat.repositories.api.env');
    // `gates` IS wired per-repo — never named.
    expect(notices[0]).not.toContain('gates');
  });

  it('names the AgentDef fields as one aggregate line, not one per agent', () => {
    const notices = detectInertKeys({
      agents: { research: { role: 'research' }, plan: { role: 'plan', command: 'x' } },
    });
    const agentLine = notices.find((n) => n.startsWith('agents.'));
    expect(agentLine).toBeDefined();
    expect(agentLine).toContain('role');
    expect(agentLine).toContain('command');
    // Required-but-unread is the confusing part; say so explicitly.
    expect(agentLine).toContain('required');
  });

  it('does not name promptPath when no agent declares one', () => {
    const notices = detectInertKeys({ agents: { research: { role: 'research' } } });
    const agentLine = notices.find((n) => n.startsWith('agents.'));
    expect(agentLine).not.toContain('promptPath');
  });

  // The retired inline prompt override: the file still LOADS, but the author
  // is told the value is dead and what replaced it — a key that silently does
  // nothing is indistinguishable from one that is broken.
  it('names a retired processes.*.instructions once, naming the profile that replaced it', () => {
    const notices = detectInertKeys({
      processes: {
        uatTester: { agent: 'tester', instructions: 'Focus on checkout.' },
        review: { instructions: 'Security first.' },
        uatFix: { provider: 'codex' },
      },
    });
    const line = notices.find((n) => n.startsWith('processes.'));
    expect(line).toBeDefined();
    expect(line).toContain('processes.*.instructions');
    expect(line).toContain('retired');
    expect(line).toContain('processes.<key>.agent');
    // Aggregated: two declaring processes still produce ONE line.
    expect(notices.filter((n) => n.startsWith('processes.'))).toHaveLength(1);
  });

  it('says nothing about processes when no retired key is declared', () => {
    expect(
      detectInertKeys({ processes: { uatTester: { agent: 'tester', provider: 'codex' } } }),
    ).toEqual([]);
  });

  it('tolerates a malformed manifest without throwing', () => {
    expect(() => detectInertKeys(null)).not.toThrow();
    expect(() => detectInertKeys('nonsense')).not.toThrow();
    expect(() => detectInertKeys({ uat: 'not-a-mapping' })).not.toThrow();
    expect(detectInertKeys({ uat: 'not-a-mapping' })).toEqual([]);
  });
});
