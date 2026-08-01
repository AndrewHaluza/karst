import { describe, it, expect } from 'vitest';
import { validateUat, uatEnvWarnings } from './uat.js';

describe('validateUat', () => {
  it('returns undefined for an absent block', () => {
    expect(validateUat(undefined)).toBeUndefined();
  });

  it('defaults every collection and maxFixAttempts', () => {
    expect(validateUat({})).toEqual({
      maxFixAttempts: 3,
      env: {},
      secrets: [],
      passthrough: [],
      origins: [],
      repositories: {},
    });
  });

  it('parses a script gate and a shell-free command gate', () => {
    const config = validateUat({
      gates: [
        { name: 'test', kind: 'script', script: 'test' },
        { name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'], repo: 'api' },
      ],
    });
    expect(config?.gates).toEqual([
      { name: 'test', kind: 'script', script: 'test' },
      { name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'], repo: 'api' },
    ]);
  });

  it('refuses a script gate with no script and a command gate with no command', () => {
    expect(() => validateUat({ gates: [{ name: 'x', kind: 'script' }] })).toThrow(/script/);
    expect(() => validateUat({ gates: [{ name: 'x', kind: 'command' }] })).toThrow(/command/);
  });

  it('refuses a gate kind it does not know', () => {
    expect(() => validateUat({ gates: [{ name: 'x', kind: 'shell', command: 'sh' }] })).toThrow(
      /uat.gates "x".kind must be one of: script, command/,
    );
  });

  // The strictness that matters: an ignored key here is a live credential in git.
  it('refuses uat.secrets as a mapping and any entry carrying a value', () => {
    expect(() => validateUat({ secrets: { STRIPE_SECRET_KEY: 'sk_live_x' } })).toThrow(
      /uat.secrets must be a list of key names/,
    );
    expect(() => validateUat({ secrets: [{ STRIPE_SECRET_KEY: 'sk_live_x' }] })).toThrow(
      /uat.secrets must be a list of key names/,
    );
  });

  it('applies the same strictness to passthrough', () => {
    expect(() => validateUat({ passthrough: { A: 'b' } })).toThrow(/uat.passthrough/);
  });

  it('accepts uat.env as a mapping of non-secret literals', () => {
    expect(validateUat({ env: { SMTP_HOST: '127.0.0.1' } })?.env).toEqual({
      SMTP_HOST: '127.0.0.1',
    });
  });

  it('refuses an origin that is not an absolute URL', () => {
    expect(() => validateUat({ origins: ['localhost:5173'] })).toThrow(/uat.origins/);
    expect(validateUat({ origins: ['http://localhost:5173'] })?.origins).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('refuses a non-positive maxFixAttempts', () => {
    expect(() => validateUat({ maxFixAttempts: 0 })).toThrow(/uat.maxFixAttempts/);
  });

  it('parses per-repository overrides', () => {
    expect(validateUat({ repositories: { web: { env: { VITE_MODE: 'uat' } } } })?.repositories).toEqual(
      { web: { env: { VITE_MODE: 'uat' } } },
    );
  });
});

describe('uatEnvWarnings', () => {
  it('warns when a uat.env value looks like a credential', () => {
    const config = validateUat({ env: { KEY: 'sk_live_abc123', MODE: 'test' } })!;
    const warnings = uatEnvWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('KEY');
  });

  it('says nothing about an ordinary literal', () => {
    expect(uatEnvWarnings(validateUat({ env: { SMTP_HOST: '127.0.0.1' } })!)).toEqual([]);
  });
});
