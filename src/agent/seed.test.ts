import { describe, it, expect } from 'vitest';
import { buildSessionSeed } from './seed.js';

// A representative pre-rendered ticket-context block (see ticketContext.test.ts
// for the shaping coverage). buildSessionSeed only composes sections.
const CONTEXT = '# Ticket: PROJ-9 — Fix login redirect\n\n## Prompt\nUsers bounce to /login.';

describe('buildSessionSeed', () => {
  it('includes the context block when given (no approach prompt)', () => {
    const seed = buildSessionSeed(CONTEXT, undefined);
    expect(seed).toBe(CONTEXT);
  });

  it('appends the approach method prompt after the ticket context', () => {
    const seed = buildSessionSeed(CONTEXT, '# Research first\nGo look.');
    expect(seed).toBeDefined();
    const ctxIdx = seed!.indexOf('PROJ-9');
    const methodIdx = seed!.indexOf('Research first');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(methodIdx).toBeGreaterThan(ctxIdx); // approach comes after context
    expect(seed).toContain('# Approach\n\n# Research first');
  });

  it('still seeds ticket context for a built-in approach (no method prompt)', () => {
    const seed = buildSessionSeed(CONTEXT, null);
    expect(seed).toBe(CONTEXT);
  });

  it('returns undefined when there is no context and no method (fully bare)', () => {
    expect(buildSessionSeed(undefined, null)).toBeUndefined();
    expect(buildSessionSeed('', '   ')).toBeUndefined();
  });

  it('seeds the approach method even when the context is empty', () => {
    const seed = buildSessionSeed(undefined, 'do the thing');
    expect(seed).toBe('# Approach\n\ndo the thing');
  });

  it('puts the invocation as the first section, before ticket context', () => {
    const seed = buildSessionSeed(CONTEXT, undefined, '/karst:rpi PROJ-9');
    expect(seed).toBeDefined();
    const lines = seed!.split('\n');
    expect(lines[0]).toBe('/karst:rpi PROJ-9');
    expect(seed!.indexOf('/karst:rpi PROJ-9')).toBe(0);
    expect(seed!.indexOf('# Ticket: PROJ-9')).toBeGreaterThan(0);
  });

  it('is byte-for-byte identical to the no-invocation output when invocation is absent/empty', () => {
    const withoutParam = buildSessionSeed(CONTEXT, 'do the thing');
    const withUndefined = buildSessionSeed(CONTEXT, 'do the thing', undefined);
    const withNull = buildSessionSeed(CONTEXT, 'do the thing', null);
    const withEmpty = buildSessionSeed(CONTEXT, 'do the thing', '   ');
    expect(withUndefined).toBe(withoutParam);
    expect(withNull).toBe(withoutParam);
    expect(withEmpty).toBe(withoutParam);
  });

  it('omits the invocation section when invocation is not given', () => {
    const seed = buildSessionSeed(CONTEXT, null);
    expect(seed).toBeDefined();
    expect(seed).not.toContain('/karst:rpi');
  });
});
