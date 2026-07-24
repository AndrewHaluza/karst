import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODELS,
  modelsForProvider,
  resolveModel,
  resolveModelForProvider,
} from './models.js';

describe('KNOWN_MODELS', () => {
  it('offers the curated launch models with stable ids', () => {
    const ids = KNOWN_MODELS.map((m) => m.id);
    expect(ids).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-low',
      'gemini-3.5-flash-high',
      'gemini-3.5-flash-medium',
      'gemini-3.5-flash-low',
      'gemini-3.1-pro-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]);
  });

  it('gives every model a human label', () => {
    for (const m of KNOWN_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('filters launch models by agent provider', () => {
    expect(modelsForProvider('claude').map((m) => m.id)).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
    ]);
    expect(modelsForProvider('antigravity').map((m) => m.id)).toContain(
      'gemini-3.6-flash-high',
    );
    expect(modelsForProvider('antigravity').map((m) => m.id)).not.toContain('claude-opus-4-8');
  });

  it('offers no speculative curated Codex models', () => {
    expect(modelsForProvider('codex')).toEqual([]);
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

describe('resolveModelForProvider', () => {
  it('preserves an explicit custom Codex model id', () => {
    expect(
      resolveModelForProvider('codex', 'team-codex-model', undefined),
    ).toBe('team-codex-model');
  });

  it('drops a known model from another provider when Codex is selected', () => {
    expect(
      resolveModelForProvider('codex', 'claude-sonnet-5', undefined),
    ).toBeUndefined();
  });

  it('skips a ticket model known to belong to another provider', () => {
    expect(
      resolveModelForProvider('antigravity', 'claude-opus-4-8', 'gemini-3.6-flash-high'),
    ).toBe('gemini-3.6-flash-high');
  });

  it('preserves unknown custom model ids', () => {
    expect(resolveModelForProvider('antigravity', 'custom-preview-model', undefined)).toBe(
      'custom-preview-model',
    );
  });
});
