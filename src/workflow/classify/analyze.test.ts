import { describe, it, expect } from 'vitest';
import { analyzeTicket } from './analyze.js';
import type { AgentAdapter, HeadlessResult } from '../../agent/adapter.js';
import type { ApproachDef } from '../../manifest/types.js';
import type { AnalyzeServiceInput } from './analyze.js';

/** A fake adapter whose runHeadless returns a canned raw string. */
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

const approaches: ApproachDef[] = [
  { id: 'rpi', label: 'Research-Plan-Implement', description: 'Ambiguous scope' },
  { id: 'gsd', label: 'Get Stuff Done', description: 'Small well-understood fixes' },
];

const services: AnalyzeServiceInput[] = [
  { name: 'backend', description: 'API server', signals: ['api', 'db'], score: 2 },
  { name: 'frontend', description: 'Web UI', signals: ['ui'], score: 0 },
];

describe('analyzeTicket', () => {
  it('returns the coupled prompt/approach/repos/reason from a clean JSON object', async () => {
    const adapter = fakeAdapter(
      JSON.stringify({
        prompt: 'Add an X button to close the login modal.',
        approach: 'gsd',
        repos: ['frontend'],
        reason: 'Small, well-understood UI fix.',
      }),
    );
    const result = await analyzeTicket(adapter, {
      brief: '# Fix login modal\n\nCannot close it.',
      services,
      approaches,
    });
    expect(result).toEqual({
      prompt: 'Add an X button to close the login modal.',
      approachId: 'gsd',
      repos: ['frontend'],
      reason: 'Small, well-understood UI fix.',
      type: 'feat',
    });
  });

  it('returns the conventional type the model picked', async () => {
    const adapter = fakeAdapter(
      '{"prompt": "p", "approach": "gsd", "repos": ["frontend"], "reason": "r", "type": "fix"}',
    );
    const result = await analyzeTicket(adapter, { brief: 'b', services, approaches });
    expect(result.type).toBe('fix');
  });

  // The type lands in branch names and PR titles; an off-vocabulary guess from
  // the model degrades to the default rather than propagating.
  it('falls back to feat for an unknown or missing type', async () => {
    const unknown = fakeAdapter(
      '{"prompt": "p", "approach": "gsd", "repos": [], "reason": "r", "type": "feature"}',
    );
    expect((await analyzeTicket(unknown, { brief: 'b', services, approaches })).type).toBe('feat');

    const missing = fakeAdapter('{"prompt": "p", "approach": "gsd", "repos": [], "reason": "r"}');
    expect((await analyzeTicket(missing, { brief: 'b', services, approaches })).type).toBe('feat');
  });

  it('parses an object wrapped in prose whose prompt spans newlines and braces', async () => {
    const raw =
      'Here is my analysis:\n' +
      '{"prompt": "Implement rate limiting.\\nUse a token bucket {per-IP}.", "approach": "rpi", "repos": ["backend"], "reason": "Cross-cutting."}\n' +
      'Hope that helps!';
    const result = await analyzeTicket(fakeAdapter(raw), {
      brief: 'Throttle the login endpoint',
      services,
      approaches,
    });
    expect(result.prompt).toBe('Implement rate limiting.\nUse a token bucket {per-IP}.');
    expect(result.approachId).toBe('rpi');
    expect(result.repos).toEqual(['backend']);
    expect(result.reason).toBe('Cross-cutting.');
  });

  it('falls back to approaches[0] when the model names an unknown approach', async () => {
    const adapter = fakeAdapter(
      '{"prompt": "do it", "approach": "waterfall", "repos": ["backend"], "reason": "x"}',
    );
    const result = await analyzeTicket(adapter, { brief: 'b', services, approaches });
    expect(result.approachId).toBe('rpi');
  });

  it('drops unknown repo names and, when none remain, falls back to keyword-scored repos', async () => {
    const adapter = fakeAdapter(
      '{"prompt": "do it", "approach": "gsd", "repos": ["nope", "ghost"], "reason": "x"}',
    );
    const result = await analyzeTicket(adapter, { brief: 'b', services, approaches });
    expect(result.repos).toEqual(['backend']); // score > 0 fallback
  });

  it('keeps only known repo names when some are valid', async () => {
    const adapter = fakeAdapter(
      '{"prompt": "do it", "approach": "gsd", "repos": ["frontend", "nope"], "reason": "x"}',
    );
    const result = await analyzeTicket(adapter, { brief: 'b', services, approaches });
    expect(result.repos).toEqual(['frontend']);
  });

  it('falls back to the user prompt then the brief when the model prompt is blank', async () => {
    const adapter = fakeAdapter('{"prompt": "   ", "approach": "gsd", "repos": ["frontend"], "reason": ""}');
    const withPrompt = await analyzeTicket(adapter, {
      brief: 'the brief text',
      prompt: 'user typed intent',
      services,
      approaches,
    });
    expect(withPrompt.prompt).toBe('user typed intent');

    const noPrompt = await analyzeTicket(adapter, {
      brief: 'the brief text',
      services,
      approaches,
    });
    expect(noPrompt.prompt).toBe('the brief text');
  });

  it('on unparseable output, falls back across all fields (prompt→brief, approach→first, repos→scored)', async () => {
    const adapter = fakeAdapter('I could not analyze this ticket, sorry.');
    const result = await analyzeTicket(adapter, {
      brief: 'the brief text',
      services,
      approaches,
    });
    expect(result).toEqual({
      prompt: 'the brief text',
      approachId: 'rpi',
      repos: ['backend'],
      reason: '',
      type: 'feat',
    });
  });

  it('includes the service list, scores, and approaches in the built prompt', async () => {
    const { adapter, prompts } = capturingAdapter(
      '{"prompt":"p","approach":"gsd","repos":["frontend"],"reason":"r"}',
    );
    await analyzeTicket(adapter, {
      brief: 'b',
      prompt: 'user intent here',
      services,
      approaches,
    });
    expect(prompts[0]).toContain('backend');
    expect(prompts[0]).toContain('frontend');
    expect(prompts[0]).toContain('gsd');
    expect(prompts[0]).toContain('user intent here');
  });

  it('constrains the synthesized prompt to be approach- and service-agnostic', async () => {
    const { adapter, prompts } = capturingAdapter(
      '{"prompt":"p","approach":"gsd","repos":["frontend"],"reason":"r"}',
    );
    await analyzeTicket(adapter, { brief: 'b', services, approaches });
    const built = prompts[0]!;
    // The prompt field is stored on the ticket and outlives the approach choice:
    // if it carries the approach's method, switching approach silently keeps it.
    expect(built).toMatch(/approach-agnostic/i);
    expect(built).toMatch(/must not.*(workflow|methodolog|phase)/is);
    expect(built).toMatch(/must not.*(repo|service)/is);
  });

  it('propagates an adapter rejection', async () => {
    await expect(
      analyzeTicket(rejectingAdapter(), { brief: 'b', services, approaches }),
    ).rejects.toThrow(/unavailable/);
  });

  it('returns empty approachId when no approaches are configured (defensive)', async () => {
    const adapter = fakeAdapter('{"prompt":"p","approach":"gsd","repos":[],"reason":"r"}');
    const result = await analyzeTicket(adapter, { brief: 'b', services, approaches: [] });
    expect(result.approachId).toBe('');
  });
});
