import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveAdapter,
  resolveProvider,
  submitDelayFor,
  IMPLEMENTED_PROVIDERS,
  isKnownProvider,
} from './registry.js';
import { DEFAULT_SUBMIT_DELAY_MS } from './adapter.js';
import { ClaudeAdapter } from './claude.js';
import { AntigravityAdapter } from './antigravity.js';
import { CodexAdapter } from './codex.js';
import { OpencodeAdapter } from './opencode.js';
import { Opencode2Adapter } from './opencode2.js';
import { FakeAdapter } from './fakeCore.js';

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

  it('resolves opencode to an OpencodeAdapter instance', () => {
    expect(resolveAdapter('opencode')).toBeInstanceOf(OpencodeAdapter);
  });

  it('resolves opencode2 to an Opencode2Adapter instance', () => {
    expect(resolveAdapter('opencode2')).toBeInstanceOf(Opencode2Adapter);
  });
});

describe('submitDelayFor', () => {
  it('returns the adapter\u2019s declared measured delay for a known provider', () => {
    for (const provider of IMPLEMENTED_PROVIDERS) {
      expect(submitDelayFor(provider)).toBe(
        resolveAdapter(provider).capabilities.submitDelayMs,
      );
    }
  });

  it('falls back to the shared default for an unknown or absent provider', () => {
    expect(submitDelayFor(undefined)).toBe(DEFAULT_SUBMIT_DELAY_MS);
    expect(submitDelayFor('evil')).toBe(DEFAULT_SUBMIT_DELAY_MS);
  });
});

describe('IMPLEMENTED_PROVIDERS', () => {
  it('lists every usable provider in stable UI order', () => {
    expect(IMPLEMENTED_PROVIDERS).toEqual([
      'claude',
      'codex',
      'antigravity',
      'opencode',
      'opencode2',
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

describe('isKnownProvider', () => {
  it('accepts every implemented provider', () => {
    expect(isKnownProvider('claude')).toBe(true);
    expect(isKnownProvider('codex')).toBe(true);
    expect(isKnownProvider('antigravity')).toBe(true);
    expect(isKnownProvider('opencode')).toBe(true);
    expect(isKnownProvider('opencode2')).toBe(true);
  });

  it('rejects an unrecognized string', () => {
    expect(isKnownProvider('evil')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isKnownProvider(42)).toBe(false);
    expect(isKnownProvider(undefined)).toBe(false);
  });
});

describe('KARST_FAKE_CORE', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('returns FakeAdapter for every provider when set to 1', () => {
    vi.stubEnv('KARST_FAKE_CORE', '1');
    for (const p of ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'] as const) {
      expect(resolveAdapter(p)).toBeInstanceOf(FakeAdapter);
    }
  });
  it('warns once per process when honored', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('KARST_FAKE_CORE', '1');
    const fresh = await import('./registry.js');
    fresh.resolveAdapter('claude');
    fresh.resolveAdapter('codex');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('fake agent core');
    warn.mockRestore();
  });
  it('launch mode keeps the real command but swaps the executable for the stub', () => {
    vi.stubEnv('KARST_FAKE_CORE', 'launch');
    vi.stubEnv('KARST_UAT_STUB_AGENT', '/d/stubAgent.js');
    const a = resolveAdapter('claude');
    expect(a).not.toBeInstanceOf(FakeAdapter);
    const cmd = a.buildInteractiveCommand({ cwd: '/wt', initialPrompt: 'hi' });
    expect(cmd.command).toBe('node');
    expect(cmd.args.slice(0, 2)).toEqual(['/d/stubAgent.js', 'claude']);
    expect(cmd.args[3]).toBe('--');
    expect(cmd.args).toContain('hi');
  });
  it('launch mode keeps runHeadless fake', async () => {
    vi.stubEnv('KARST_FAKE_CORE', 'launch');
    vi.stubEnv('KARST_UAT_STUB_AGENT', '/d/stubAgent.js');
    expect((await resolveAdapter('codex').runHeadless({} as never)).raw).toContain('fake core');
  });
  it('launch mode without a stub path falls through to the real adapter', () => {
    vi.stubEnv('KARST_FAKE_CORE', 'launch');
    vi.stubEnv('KARST_UAT_STUB_AGENT', '');
    expect(resolveAdapter('claude')).toBeInstanceOf(ClaudeAdapter);
  });
  it('is off by default', () => {
    vi.stubEnv('KARST_FAKE_CORE', '');
    expect(resolveAdapter('claude')).toBeInstanceOf(ClaudeAdapter);
  });
});
