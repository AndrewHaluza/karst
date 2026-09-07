import { describe, it, expect } from 'vitest';
import { buildSessionSeed, measureSeed } from './seed.js';
import { markerStageFor } from './markerStage.js';
import { renderGateOnlyInstruction, renderDoneMarkerInstruction } from './workflowCommand.js';

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

  it('appends the marker instruction as the final section when given', () => {
    const seed = buildSessionSeed(CONTEXT, null, undefined, 'RUN THE MARKER');
    expect(seed).toBeDefined();
    expect(seed!.endsWith('RUN THE MARKER')).toBe(true);
    // marker comes after the ticket context
    expect(seed!.indexOf('RUN THE MARKER')).toBeGreaterThan(seed!.indexOf('PROJ-9'));
  });

  it('seeds the marker even when there is no context and no method (direct/bare ticket)', () => {
    expect(buildSessionSeed(undefined, null, undefined, 'RUN THE MARKER')).toBe('RUN THE MARKER');
  });

  it('is unchanged when no marker is given (4th arg absent)', () => {
    expect(buildSessionSeed(CONTEXT, null)).toBe(CONTEXT);
    expect(buildSessionSeed(CONTEXT, null, undefined, undefined)).toBe(CONTEXT);
  });

  it('places the guide instruction after the method and before the marker', () => {
    const seed = buildSessionSeed(
      CONTEXT,
      'do the thing',
      undefined,
      'RUN THE MARKER',
      'READ THE GUIDE',
    );
    expect(seed).toBeDefined();
    const methodIdx = seed!.indexOf('do the thing');
    const guideIdx = seed!.indexOf('READ THE GUIDE');
    const markerIdx = seed!.indexOf('RUN THE MARKER');
    expect(methodIdx).toBeGreaterThanOrEqual(0);
    expect(guideIdx).toBeGreaterThan(methodIdx);
    expect(markerIdx).toBeGreaterThan(guideIdx);
  });

  it('is unchanged when no guide instruction is given (5th arg absent)', () => {
    expect(buildSessionSeed(CONTEXT, 'do the thing', undefined, 'RUN THE MARKER')).toBe(
      buildSessionSeed(CONTEXT, 'do the thing', undefined, 'RUN THE MARKER', undefined),
    );
  });

  // Issue #6: a ticket seeded at a gate stage (uat/review/ship) has no marker to
  // fire — markerStageFor returns null there — but the seed must still say
  // something about how the stage ends, per the same extension.ts wiring used
  // for a review-stage ticket's session.
  it('carries the gate sentence and no marker command for a review-stage ticket', () => {
    const markerStage = markerStageFor('review');
    expect(markerStage).toBeNull();
    const markerInstruction =
      markerStage === null
        ? renderGateOnlyInstruction()
        : renderDoneMarkerInstruction('node cli.js stage review pass --ticket', 'PROJ-9');
    const seed = buildSessionSeed(CONTEXT, null, undefined, markerInstruction);
    expect(seed).toBeDefined();
    expect(seed!.toLowerCase()).toContain('gate exit codes');
    expect(seed!.toLowerCase()).not.toContain('stage review pass');
    expect(seed!.toLowerCase()).not.toContain('stage impl pass');
    expect(seed!.toLowerCase()).not.toContain('stage fix pass');
    expect(seed!.toLowerCase()).not.toContain('done marker');
  });
});

describe('measureSeed', () => {
  it('reports composed length and guide-pointer presence for a full seed', () => {
    const seed = buildSessionSeed(
      CONTEXT,
      '# Method',
      '/karst:rpi PROJ-9',
      'fire the marker',
      'To understand how Karst works and what this CLI can do, run `g`',
    )!;
    const m = measureSeed(seed);
    expect(m.seedChars).toBe(seed.length);
    expect(m.guidePointer).toBe(true);
  });

  it('reports guidePointer false when the seed carries no pointer', () => {
    const seed = buildSessionSeed(CONTEXT, undefined)!;
    expect(measureSeed(seed).guidePointer).toBe(false);
  });

  it('reports zero length for a bare launch (undefined seed)', () => {
    expect(measureSeed(undefined)).toEqual({ seedChars: 0, guidePointer: false });
  });
});

