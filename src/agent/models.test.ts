import { describe, it, expect } from 'vitest';
import { KNOWN_MODELS, resolveModel } from './models.js';

describe('KNOWN_MODELS', () => {
  it('offers the curated launch models with stable ids', () => {
    const ids = KNOWN_MODELS.map((m) => m.id);
    expect(ids).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
    ]);
  });

  it('gives every model a human label', () => {
    for (const m of KNOWN_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveModel', () => {
  it('prefers the ticket model over the default', () => {
    expect(resolveModel('claude-opus-4-8', 'claude-sonnet-5')).toBe('claude-opus-4-8');
  });

  it('falls back to the default when the ticket has no model', () => {
    expect(resolveModel(null, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('returns undefined (CLI default) when neither is set', () => {
    expect(resolveModel(null, undefined)).toBeUndefined();
  });

  it('treats a blank ticket model as "inherit"', () => {
    expect(resolveModel('  ', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('treats a blank default as unset', () => {
    expect(resolveModel(null, '   ')).toBeUndefined();
  });
});
