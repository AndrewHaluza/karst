import { describe, it, expect } from 'vitest';
import { resolveAdapter, IMPLEMENTED_PROVIDERS } from './registry.js';
import { ClaudeAdapter } from './claude.js';

describe('resolveAdapter', () => {
  it('resolves claude to a ClaudeAdapter instance', () => {
    expect(resolveAdapter('claude')).toBeInstanceOf(ClaudeAdapter);
  });

  it('falls back to ClaudeAdapter for an unimplemented provider (codex)', () => {
    expect(resolveAdapter('codex')).toBeInstanceOf(ClaudeAdapter);
  });
});

describe('IMPLEMENTED_PROVIDERS', () => {
  it('lists only claude', () => {
    expect(IMPLEMENTED_PROVIDERS).toEqual(['claude']);
  });
});
