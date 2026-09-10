import { describe, it, expect } from 'vitest';
import { improveDescription, BUILT_IN_IMPROVE_PROMPT } from './improve.js';
import type { AgentAdapter, HeadlessResult } from '../../agent/adapter.js';

function fakeAdapter(raw: string): AgentAdapter {
  return {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    async runHeadless(): Promise<HeadlessResult> {
      return { sessionId: 's1', verdict: null, raw };
    },
  };
}

function capturingAdapter(raw: string): { adapter: AgentAdapter; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    adapter: {
      requiredBinary: 'claude',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
      async runHeadless(opts): Promise<HeadlessResult> {
        prompts.push(opts.prompt);
        return { sessionId: 's1', verdict: null, raw };
      },
    },
  };
}

function rejectingAdapter(): AgentAdapter {
  return {
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    runHeadless: () => Promise.reject(new Error('agent unavailable')),
  };
}

describe('improveDescription', () => {
  it('returns the trimmed raw prose when given instructions', async () => {
    const result = await improveDescription(fakeAdapter('  Rewritten description.  '), {
      instructions: 'Rewrite the description.',
      description: 'Fix the login button.',
      title: 'Login',
      cwd: '/proj',
    });
    expect(result).toBe('Rewritten description.');
  });

  it('composes a prompt containing the instruction body, title, and source description', async () => {
    const { adapter, prompts } = capturingAdapter('Improved text');
    await improveDescription(adapter, {
      instructions: 'You are a description-improver.',
      description: 'Fix the login button.',
      title: 'Login',
      cwd: '/proj',
    });
    const prompt = prompts[0]!;
    expect(prompt).toContain('You are a description-improver.');
    expect(prompt).toContain('Title: Login');
    expect(prompt).toContain('Fix the login button.');
    expect(prompt).toContain('Rewrite it per the instructions above.');
  });

  it('uses BUILT_IN_IMPROVE_PROMPT when instructions is blank', async () => {
    const { adapter, prompts } = capturingAdapter('Improved');
    await improveDescription(adapter, {
      instructions: '   ',
      description: 'Fix the button.',
      title: '',
      cwd: '/proj',
    });
    const prompt = prompts[0]!;
    expect(prompt).toContain(BUILT_IN_IMPROVE_PROMPT);
    expect(prompt).toContain('Fix the button.');
  });

  it('passes cwd, model, and effort through to runHeadless', async () => {
    const calls: Array<{ cwd: string; model?: string; effort?: string }> = [];
    const adapter: AgentAdapter = {
      requiredBinary: 'claude',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
      async runHeadless(opts): Promise<HeadlessResult> {
        calls.push({ cwd: opts.cwd, model: opts.model, effort: opts.effort });
        return { sessionId: 's1', verdict: null, raw: 'ok' };
      },
    };
    await improveDescription(adapter, {
      instructions: 'Rewrite.',
      description: 'text',
      title: 'T',
      cwd: '/proj',
      model: 'claude-sonnet-5',
      effort: 'high',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/proj');
    expect(calls[0]!.model).toBe('claude-sonnet-5');
    expect(calls[0]!.effort).toBe('high');
  });

  it('renders "Primary repository: <path>" when repoPath is given', async () => {
    const { adapter, prompts } = capturingAdapter('ok');
    await improveDescription(adapter, {
      instructions: 'Rewrite.',
      description: 'text',
      title: 'T',
      cwd: '/proj',
      repoPath: '/elsewhere/fe',
    });
    expect(prompts[0]).toContain('Primary repository: /elsewhere/fe');
  });

  it('omits the repository line when repoPath is absent', async () => {
    const { adapter, prompts } = capturingAdapter('ok');
    await improveDescription(adapter, {
      instructions: 'Rewrite.',
      description: 'text',
      title: 'T',
      cwd: '/proj',
    });
    expect(prompts[0]).not.toContain('Primary repository:');
  });

  it('passes tracking.callSite === ticket-analysis and processRunId through', async () => {
    const calls: Array<{ tracking?: { callSite: string; processRunId?: number | null } }> = [];
    const adapter: AgentAdapter = {
      requiredBinary: 'claude',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
      async runHeadless(opts): Promise<HeadlessResult> {
        calls.push({ tracking: opts.tracking as { callSite: string; processRunId?: number | null } | undefined });
        return { sessionId: 's1', verdict: null, raw: 'ok' };
      },
    };
    await improveDescription(adapter, {
      instructions: 'Rewrite.',
      description: 'text',
      title: 'T',
      cwd: '/proj',
      processRunId: 42,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tracking?.callSite).toBe('ticket-analysis');
    expect(calls[0]!.tracking?.processRunId).toBe(42);
  });

  it('throws "nothing to improve" when description is blank', async () => {
    await expect(
      improveDescription(fakeAdapter('ok'), {
        instructions: 'Rewrite.',
        description: '   ',
        title: 'T',
        cwd: '/proj',
      }),
    ).rejects.toThrow('nothing to improve');
  });

  it('propagates an adapter rejection', async () => {
    await expect(
      improveDescription(rejectingAdapter(), {
        instructions: 'Rewrite.',
        description: 'text',
        title: 'T',
        cwd: '/proj',
      }),
    ).rejects.toThrow(/unavailable/);
  });

  it('renders the title as "(untitled)" when title is empty', async () => {
    const { adapter, prompts } = capturingAdapter('ok');
    await improveDescription(adapter, {
      instructions: 'Rewrite.',
      description: 'text',
      title: '',
      cwd: '/proj',
    });
    expect(prompts[0]).toContain('Title: (untitled)');
  });

  it('passes ticketId through in tracking', async () => {
    const calls: Array<{ tracking?: { ticketId?: number | null } }> = [];
    const adapter: AgentAdapter = {
      requiredBinary: 'claude',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
      async runHeadless(opts): Promise<HeadlessResult> {
        calls.push({ tracking: opts.tracking as { ticketId?: number | null } | undefined });
        return { sessionId: 's1', verdict: null, raw: 'ok' };
      },
    };
    await improveDescription(adapter, {
      instructions: 'Rewrite.',
      description: 'text',
      title: 'T',
      cwd: '/proj',
      ticketId: 7,
    });
    expect(calls[0]!.tracking?.ticketId).toBe(7);
  });
});
