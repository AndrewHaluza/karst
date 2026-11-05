import { describe, it, expect } from 'vitest';
import { buildBuiltInPrompts } from './builtInPrompts.js';
import type { Manifest } from '../../manifest/types.js';
import { PROMPT_BEARING_PROCESS_KEYS, PROCESS_KEYS } from '../../manifest/validate/processAssignments.js';

describe('built-in prompts', () => {
  const prompts = buildBuiltInPrompts();
  it('has a real prompt for every prompt-bearing role and none for the others', () => {
    for (const key of PROCESS_KEYS) {
      const text = prompts[key];
      if (PROMPT_BEARING_PROCESS_KEYS.includes(key)) expect(text && text.length > 50, key).toBe(true);
      else expect(text, key).toBeNull();
    }
  });
  it('renders the builders with placeholder targets', () => {
    expect(prompts.uatTester).toContain('<repository>');
    expect(prompts.review).toContain('<repository>');
  });

  describe('output rule follows the core each role is assigned to', () => {
    const TOOL = 'Finish by calling the StructuredOutput tool';
    const DOC = 'Your final message is ONLY a JSON object with one key, `findings`';
    const NONE = 'Output ONLY a JSON array, nothing else';
    const manifestFor = (agentProvider: string): Manifest => ({ agentProvider }) as unknown as Manifest;

    it.each([
      ['claude', TOOL],
      ['codex', DOC],
      ['antigravity', NONE],
      ['opencode', NONE],
      ['opencode2', NONE],
    ])('%s core shows its own rule in the tester and review prompts', (provider, rule) => {
      const built = buildBuiltInPrompts(manifestFor(provider));
      expect(built.uatTester).toContain(rule);
      expect(built.review).toContain(rule);
    });

    it('shows the prose rule when no manifest is known', () => {
      expect(buildBuiltInPrompts().review).toContain(NONE);
    });
  });
});
