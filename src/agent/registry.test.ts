import { describe, it, expect } from 'vitest';
import { resolveAdapter, IMPLEMENTED_PROVIDERS } from './registry.js';
import { ClaudeAdapter } from './claude.js';
import { AntigravityAdapter } from './antigravity.js';
import { CodexAdapter } from './codex.js';

describe('resolveAdapter', () => {
  it('resolves claude to a ClaudeAdapter instance', () => {
    expect(resolveAdapter('claude')).toBeInstanceOf(ClaudeAdapter);
  });

  it('resolves antigravity to an AntigravityAdapter instance', () => {
    expect(resolveAdapter('antigravity')).toBeInstanceOf(AntigravityAdapter);
  });

  it('resolves codex to a CodexAdapter instance', () => {
    expect(resolveAdapter('codex')).toBeInstanceOf(CodexAdapter);
  });
});

describe('IMPLEMENTED_PROVIDERS', () => {
  it('lists every usable provider in stable UI order', () => {
    expect(IMPLEMENTED_PROVIDERS).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);
  });
});
