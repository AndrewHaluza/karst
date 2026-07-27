import { describe, it, expect } from 'vitest';
import { resolveAdapter, resolveProvider, IMPLEMENTED_PROVIDERS } from './registry.js';
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

describe('resolveProvider', () => {
  it('prefers the ticket provider over the manifest default', () => {
    expect(resolveProvider('codex', 'claude')).toBe('codex');
  });

  it('falls back to the manifest default when the ticket has no override', () => {
    expect(resolveProvider(null, 'antigravity')).toBe('antigravity');
    expect(resolveProvider(undefined, 'antigravity')).toBe('antigravity');
  });

  it('falls back to claude when neither the ticket nor the manifest specify a provider', () => {
    expect(resolveProvider(null, null)).toBe('claude');
    expect(resolveProvider(undefined, undefined)).toBe('claude');
  });
});
