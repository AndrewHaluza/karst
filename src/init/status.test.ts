import { describe, it, expect } from 'vitest';
import { buildSetupStatus, AGENT_AUTH_REMINDER } from './status.js';
import { GIT_DEPENDENCY, agentDependency } from '../runtime/deps.js';

describe('buildSetupStatus', () => {
  it('marks all items done when nothing is missing', () => {
    const items = buildSetupStatus({ manifestExists: true, missingDeps: [], provider: 'claude' });
    expect(items.map((i) => i.id)).toEqual(['manifest', 'git', 'agent-cli']);
    expect(items.every((i) => i.done)).toBe(true);
  });

  it('marks the manifest item undone when the manifest is missing', () => {
    const items = buildSetupStatus({ manifestExists: false, missingDeps: [], provider: 'claude' });
    expect(items.find((i) => i.id === 'manifest')!.done).toBe(false);
  });

  it('marks git undone when git is in missingDeps', () => {
    const items = buildSetupStatus({
      manifestExists: true,
      missingDeps: [GIT_DEPENDENCY],
      provider: 'claude',
    });
    const git = items.find((i) => i.id === 'git')!;
    expect(git.done).toBe(false);
    expect(git.detail).toBe(GIT_DEPENDENCY.install);
  });

  it('marks the agent CLI undone when its binary is in missingDeps and carries install detail', () => {
    const claudeDep = agentDependency('claude');
    const items = buildSetupStatus({
      manifestExists: true,
      missingDeps: [claudeDep],
      provider: 'claude',
    });
    const cli = items.find((i) => i.id === 'agent-cli')!;
    expect(cli.done).toBe(false);
    expect(cli.detail).toContain(claudeDep.install);
    expect(cli.detail).toContain(AGENT_AUTH_REMINDER);
  });

  it('always includes the auth reminder in the agent-cli detail even when done', () => {
    const items = buildSetupStatus({ manifestExists: true, missingDeps: [], provider: 'claude' });
    const cli = items.find((i) => i.id === 'agent-cli')!;
    expect(cli.done).toBe(true);
    expect(cli.detail).toBe(AGENT_AUTH_REMINDER);
  });
});
