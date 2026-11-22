/**
 * The display-name helpers and the "Inherited:" line (SET-35).
 *
 * These live in the webview bundle, so they read the browser-safe registries
 * (`AGENT_PROVIDER_LABELS`, `bundledModelCatalog`) — never the host-only
 * `labelForProvider` / `labelForModel`, whose module reads icon assets from disk.
 */
import { describe, expect, it } from 'vitest';
import type { PresetInheritance } from '../../presetMatrix.js';
import { inheritedText, modelLabel, providerLabel } from './presetDraft.js';

describe('display names (SET-35)', () => {
  it('uses the shared provider registry, with a title-cased fallback', () => {
    expect(providerLabel('claude')).toBe('Claude Code');
    expect(providerLabel('antigravity')).toBe('Antigravity CLI');
    expect(providerLabel('opencode2')).toBe('OpenCode v2');
    expect(providerLabel('acme')).toBe('Acme');
    expect(providerLabel('')).toBe('');
  });

  it('uses the bundled model catalog, the raw id when unknown, and Agent default when empty', () => {
    expect(modelLabel('claude', 'claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelLabel('claude', 'house-model-7')).toBe('house-model-7');
    expect(modelLabel('claude', '')).toBe('Agent default');
    expect(modelLabel('claude', undefined)).toBe('Agent default');
  });
});

describe('inheritedText (SET-35)', () => {
  const inheritance = {
    planning: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    review: { provider: 'codex', model: 'gpt-5.6-sol' },
  } as unknown as PresetInheritance;

  it('joins display names, never raw ids', () => {
    expect(inheritedText('planning', inheritance)).toBe('Inherited: Claude Code · Sonnet 5.5 · high');
    expect(inheritedText('review', inheritance)).toBe('Inherited: Codex · GPT-5.6 Sol');
  });

  it('falls back to project defaults when the host has no preview', () => {
    expect(inheritedText('planning', undefined)).toBe('Inherited: project defaults');
  });
});
