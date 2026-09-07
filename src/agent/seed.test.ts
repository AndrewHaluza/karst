import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { buildSessionSeed, measureSeed } from './seed.js';
import { markerStageFor } from './markerStage.js';
import { renderGateOnlyInstruction, renderDoneMarkerInstruction } from './workflowCommand.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { insertAttachment } from '../store/attachments.js';
import { setStage } from '../store/stages.js';
import { recordGateRun } from '../store/gateRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { buildTicketContext, renderTicketContext } from '../context/ticketContext.js';

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

describe('buildSessionSeed budget', () => {
  it('truncates an oversized approach method with the stated pointer', () => {
    const bigMethod = '# Big approach\n' + 'z'.repeat(20_000);
    const seed = buildSessionSeed(CONTEXT, bigMethod, undefined, undefined, undefined, 'PROJ-9');
    expect(seed).toContain('truncated -- run `karst context PROJ-9` for the full state.');
    // 8000-char budget applies to the whole method text, including the 15-char
    // "# Big approach\n" heading, so 8000 - 15 = 7985 'z' characters survive.
    expect(seed!.match(/z/g)!.length).toBe(7985);
  });

  it('never truncates the marker instruction, even with a huge context and method', () => {
    const bigContext = 'c'.repeat(50_000);
    const bigMethod = 'm'.repeat(50_000);
    const marker = 'FIRE THE MARKER: run `karst stage impl pass`';
    const seed = buildSessionSeed(bigContext, bigMethod, undefined, marker, undefined, 'PROJ-9');
    expect(seed).toContain(marker);
  });

  it('reports truncation via the injected debug callback', () => {
    const bigMethod = 'z'.repeat(20_000);
    const seen: string[] = [];
    buildSessionSeed(CONTEXT, bigMethod, undefined, undefined, undefined, 'PROJ-9', (m) => seen.push(m));
    expect(seen.some((m) => m.includes('approach method'))).toBe(true);
  });

  it('does not truncate a method body under budget', () => {
    const seed = buildSessionSeed(CONTEXT, '# Small\nGo look.', undefined, undefined, undefined, 'PROJ-9');
    expect(seed).not.toContain('truncated --');
  });
});

describe('oversized ticket end-to-end budget (PROMPT-08 acceptance)', () => {
  it('a ticket with a huge prompt, brief, and approach method still produces a bounded, marker-intact seed', () => {
    // Context is pre-shaped (realistic ~10k+ chars), mimicking renderTicketContext output
    const hugeContext =
      `# Ticket: PROJ-9 — Oversized\n\n## Prompt\n${'p'.repeat(5_000)}\n\n` +
      `## Context brief\n${'b'.repeat(4_500)}`;
    // Approach method is genuinely huge (50k), will be truncated to 8000-char budget
    const hugeMethod = '# rpi-implement\n' + 'm'.repeat(50_000);
    const marker = 'Run `karst stage impl pass --ticket PROJ-9` when done.';

    const seed = buildSessionSeed(
      hugeContext,
      hugeMethod,
      '/karst:rpi PROJ-9',
      marker,
      'Run `karst guide` to learn the CLI.',
      'PROJ-9',
    );

    expect(seed).toBeDefined();
    // (a) fits: total seed stays well under the design ceiling of ~20,200 chars
    // (docs/superpowers/plans/2026-09-07-seed-budget.md, "Budget derivation")
    // — invocation + pre-shaped context + truncated method + marker + guide
    expect(seed!.length).toBeLessThan(20_200);
    // (b) the marker instruction survives verbatim.
    expect(seed).toContain(marker);
    // (c) the truncation pointer is present (context wasn't bounded by
    // buildSessionSeed itself in this fixture, but the approach method was).
    expect(seed).toContain('truncated -- run `karst context PROJ-9` for the full state.');
  });

  describe('real end-to-end pipeline with maxed-out context fields', () => {
    let store: Store;
    beforeEach(() => (store = openStore(':memory:')));
    afterEach(() => store.close());

    it('maxes out multiple growable fields and still stays bounded with a huge method', () => {
      // Create a ticket with multiple fields near their budgets
      const t = createTicket(store, { key: 'PROJ-9', title: 'Oversized integration test' });

      // Fill prompt near 4000-char budget, brief near 3000-char budget
      updateTicketFields(store, t.id, {
        description: 'Prompt: ' + 'p'.repeat(3900),
        brief: 'Brief: ' + 'b'.repeat(2900),
        approach: 'rpi',
        selectedRepos: ['frontend'],
      });

      // Set stage and record gate runs with summaries totaling ~1000 chars
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
      setStage(store, t.id, 'review', { status: 'running' });
      recordGateRun(store, {
        ticketId: t.id,
        stageKey: 'review',
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        gates: [
          { gateName: 'test-gate', exitCode: 1, summary: 's'.repeat(480) },
          { gateName: 'lint-gate', exitCode: 1, summary: 's'.repeat(480) },
        ],
      });

      // Findings list near 2000 chars
      const findings = [];
      for (let i = 0; i < 20; i++) {
        findings.push({
          severity: 'warning' as const,
          repo: '/repo',
          file: 'src/file.ts',
          line: i * 10,
          title: `Issue ${i}`,
          detail: 'd'.repeat(50),
          source: 'agent' as const,
        });
      }
      recordFindings(store, {
        ticketId: t.id,
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        findings,
      });

      // Attachments list near 1500 chars
      for (let i = 0; i < 5; i++) {
        insertAttachment(store, {
          ticketId: t.id,
          kind: 'file' as const,
          storedName: `a${i}.txt`,
          originalName: `file${i}-with-long-descriptive-name-${'x'.repeat(80)}.txt`,
          byteSize: 100,
        });
      }

      // Build context and render it through the real pipeline
      const ctx = buildTicketContext(store, undefined, t.id, '/storage');
      const renderedContext = renderTicketContext(ctx);

      // Huge approach method (50k chars, will be truncated to 8000-char budget)
      const hugeMethod = '# rpi-implement\n' + 'm'.repeat(50_000);
      const marker = 'Run `karst stage impl pass --ticket PROJ-9` when done.';
      const seed = buildSessionSeed(
        renderedContext,
        hugeMethod,
        '/karst:rpi PROJ-9',
        marker,
        'Run `karst guide` to learn the CLI.',
        'PROJ-9',
      );

      expect(seed).toBeDefined();
      // (a) fits: total seed stays under the design ceiling of ~20,200 chars
      // despite maxing out multiple growable fields + huge method
      expect(seed!.length).toBeLessThan(20_200);
      // (b) the marker instruction survives verbatim
      expect(seed).toContain(marker);
      // (c) at least one truncation pointer is present
      // (the approach method was truncated since it's 50k chars)
      expect(seed).toContain('truncated -- run `karst context PROJ-9` for the full state.');
    });
  });
});

