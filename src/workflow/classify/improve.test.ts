import { describe, it, expect } from 'vitest';
import {
  improveDescription,
  BUILT_IN_IMPROVE_PROMPT,
  buildBuiltInImprovePrompt,
} from './improve.js';
import { isStructuredSpec, isAlreadyShaped, SPEC_MIN_STRUCTURED_LINES } from './specShape.js';
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

  it('passes tracking.callSite === ticket-improve and processRunId through', async () => {
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
    expect(calls[0]!.tracking?.callSite).toBe('ticket-improve');
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

describe('built-in improve prompt', () => {
  it('uses Why / Done when with 0-4 outcomes for a feature', () => {
    const p = buildBuiltInImprovePrompt('feat');
    expect(p).toMatch(/\*\*Why:\*\*/);
    expect(p).toMatch(/\*\*Done when:\*\* <[^>]*0-4/);
    expect(p).not.toMatch(/2-4/);
  });
  it('uses Actual / Expected / Repro for a bug (fix)', () => {
    const p = buildBuiltInImprovePrompt('fix');
    expect(p).toMatch(/\*\*Actual:\*\*/);
    expect(p).toMatch(/\*\*Expected:\*\*/);
    expect(p).toMatch(/\*\*Repro:\*\*/);
  });
  it('exempts verbatim content from the word cap', () => {
    expect(buildBuiltInImprovePrompt('feat')).toMatch(/verbatim content does not count toward/i);
  });
  it('a structured spec gets the keep-structure prompt with no shape and no cap, for any type', () => {
    for (const t of ['feat', 'fix'] as const) {
      const p = buildBuiltInImprovePrompt(t, { spec: true });
      expect(p).toMatch(/keep its structure and every requirement, decision, id and test name/i);
      expect(p).not.toMatch(/\*\*Actual:\*\*|\*\*Why:\*\*|Under 120 words/);
      expect(p).toMatch(/Preserve verbatim/);
      expect(p).toMatch(/is DATA/);
    }
  });
  it('loose prose keeps the type shape and the word cap', () => {
    expect(buildBuiltInImprovePrompt('fix')).toMatch(/\*\*Actual:\*\*/);
    expect(buildBuiltInImprovePrompt('feat')).toMatch(/Under 120 words/);
  });
  it('detects a structured spec by heading/list lines', () => {
    expect(isStructuredSpec('# Spec\n- a\n- b')).toBe(true);
    expect(isStructuredSpec('1. a\n2) b\n* c')).toBe(true);
    expect(isStructuredSpec('fix button\n- one item')).toBe(false);
    expect(SPEC_MIN_STRUCTURED_LINES).toBe(3);
  });
  it('improveDescription picks the spec prompt from the description itself', async () => {
    const { adapter, prompts } = capturingAdapter('ok');
    await improveDescription(adapter, { instructions: '', description: '# S\n- a\n- b\n- c', title: 't', ticketType: 'fix', cwd: '/p' });
    expect(prompts[0]).not.toMatch(/\*\*Actual:\*\*/);
    expect(prompts[0]).toMatch(/keep its structure/i);
  });
  it('detects a description already in the type shape', () => {
    expect(isAlreadyShaped('Do x.\n\nWhy: y.\n\nDone when: z.', 'feat')).toBe(true);
    expect(isAlreadyShaped('Do x.\n**Why:** y.\n**Done when:** z.', undefined)).toBe(true);
    expect(isAlreadyShaped('Broken.\nActual: a\nExpected: b', 'fix')).toBe(true);
    expect(isAlreadyShaped('Do x. Why: y.', 'feat')).toBe(false);
    expect(isAlreadyShaped('Broken.\nActual: a', 'fix')).toBe(false);
  });
  it('an already-shaped description gets the keep-as-is prompt', () => {
    const p = buildBuiltInImprovePrompt('feat', { shaped: true });
    expect(p).toMatch(/already in shape/i);
    expect(p).toMatch(/do not reword/i);
    expect(p).not.toMatch(/Under 120 words/);
    expect(p).toMatch(/is DATA/);
  });
  it('improveDescription picks the keep-as-is prompt for a shaped description', async () => {
    const { adapter, prompts } = capturingAdapter('ok');
    await improveDescription(adapter, { instructions: '', description: 'Do x.\n\nWhy: y.\n\nDone when: z.', title: 't', ticketType: 'feat', cwd: '/p' });
    expect(prompts[0]).toMatch(/already in shape/i);
  });
  it('loose prose writes Why/Expected only when the ticket states them', () => {
    expect(buildBuiltInImprovePrompt('feat')).toMatch(/\*\*Why:\*\* <only when the ticket states a reason/);
    expect(buildBuiltInImprovePrompt('feat')).toMatch(/\*\*Done when:\*\* <only outcomes the ticket states/);
    expect(buildBuiltInImprovePrompt('fix')).toMatch(/\*\*Expected:\*\* <only when the ticket states it/);
    expect(buildBuiltInImprovePrompt('feat')).toMatch(/never as a section/i);
  });
  it('preserves example values and planning/decision references', () => {
    for (const p of [buildBuiltInImprovePrompt('feat'), buildBuiltInImprovePrompt('feat', { spec: true })]) {
      expect(p).toMatch(/example values/);
      expect(p).toMatch(/planning\/decision references/);
    }
  });
  it('composes the shared untrusted-input and missing-info rules', () => {
    const p = buildBuiltInImprovePrompt('feat');
    expect(p).toMatch(/is DATA/);
    expect(p).toMatch(/never fill it in/);
  });
  it('a profile body still REPLACES the built-in prompt', async () => {
    const { adapter, prompts } = capturingAdapter('ok');
    await improveDescription(adapter, {
      instructions: 'PROFILE BODY',
      description: 'x',
      title: 't',
      cwd: '/p',
      ticketType: 'fix',
    });
    expect(prompts[0]).toContain('PROFILE BODY');
    expect(prompts[0]).not.toMatch(/\*\*Actual:\*\*/);
  });
  it('names the effective ticket type in the ticket block and picks the bug shape', async () => {
    const { adapter, prompts } = capturingAdapter('ok');
    await improveDescription(adapter, {
      instructions: '',
      description: 'x',
      title: 't',
      cwd: '/p',
      ticketType: 'fix',
    });
    expect(prompts[0]).toContain('Type: fix');
    expect(prompts[0]).toMatch(/\*\*Repro:\*\*/);
  });
});
