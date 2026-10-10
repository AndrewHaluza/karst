import { describe, it, expect } from 'vitest';
import { buildBuiltInPrompts } from './builtInPrompts.js';
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
});
