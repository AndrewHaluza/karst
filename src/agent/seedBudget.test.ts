import { describe, it, expect } from 'vitest';
import {
  truncateToBudget,
  truncationPointer,
  approachTruncationPointer,
  keylessTruncationPointer,
  SEED_BUDGETS,
} from './seedBudget.js';

describe('truncateToBudget', () => {
  it('returns text unchanged when under budget', () => {
    const result = truncateToBudget('short text', 100, 'PROJ-1');
    expect(result).toEqual({ text: 'short text', truncated: false });
  });

  it('returns text unchanged when exactly at budget', () => {
    const text = 'x'.repeat(10);
    const result = truncateToBudget(text, 10, 'PROJ-1');
    expect(result).toEqual({ text, truncated: false });
  });

  it('cuts to budget and appends the stated pointer when over budget', () => {
    const text = 'x'.repeat(20);
    const result = truncateToBudget(text, 10, 'PROJ-1');
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('x'.repeat(10) + truncationPointer('PROJ-1'));
  });

  it('names the ticket key in the pointer', () => {
    expect(truncationPointer('PROJ-9')).toBe(
      ' ... truncated -- run `karst context PROJ-9` for the full state.',
    );
  });

  it('accepts a pointer override for the one section karst context cannot recover', () => {
    const text = 'x'.repeat(20);
    const override = ' ... truncated -- see the approach package on disk.';
    const result = truncateToBudget(text, 10, 'PROJ-1', override);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('x'.repeat(10) + override);
    expect(result.text).not.toContain('karst context');
  });

  it('states truncation without naming a command when there is no ticket key', () => {
    const text = 'x'.repeat(20);
    const result = truncateToBudget(text, 10, '', keylessTruncationPointer());
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('x'.repeat(10) + keylessTruncationPointer());
    expect(result.text).not.toContain('karst context');
  });

  it('falls back to the default ticket-key pointer when no override is given', () => {
    const text = 'x'.repeat(20);
    const result = truncateToBudget(text, 10, 'PROJ-1');
    expect(result.text).toBe('x'.repeat(10) + truncationPointer('PROJ-1'));
  });

  it('approachTruncationPointer never tells the agent to run karst context for the approach body', () => {
    const pointer = approachTruncationPointer();
    // It's allowed to NAME `karst context` while explaining that command
    // can't help here — what it must never do is tell the agent to RUN it.
    expect(pointer).not.toContain('run `karst context');
    expect(pointer).toContain('approach method is longer than fits here');
  });

  it('closes an unterminated code fence when the cut lands inside one', () => {
    const text = 'line1\n```\ncode block content\nmore code\nrest of text after fence\n```\n';
    const maxChars = text.indexOf('more code') + 5; // cut mid-fence
    const result = truncateToBudget(text, maxChars, 'PROJ-1');
    expect(result.truncated).toBe(true);
    // The sliced text has an odd number of fences (1 opening, 0 closing).
    // closeOpenFence appends a closing fence before the pointer.
    // The result ends with: ...more \n```\n ... truncated ...
    expect(result.text).toContain('\n```\n');
    expect(result.text).toContain(truncationPointer('PROJ-1'));
    // Pointer is outside the fence.
    const pointerIdx = result.text.indexOf(truncationPointer('PROJ-1'));
    const lastFenceIdx = result.text.lastIndexOf('```', pointerIdx - 1);
    expect(lastFenceIdx).toBeLessThan(pointerIdx);
  });

  it('does not append a fence when the cut lands outside any fence', () => {
    const text = 'line1\n```\ncode\n```\nline after fence\nmore text here\n';
    const maxChars = text.indexOf('line after fence') + 5;
    const result = truncateToBudget(text, maxChars, 'PROJ-1');
    expect(result.truncated).toBe(true);
    // Even number of fences in the slice — no fence appended.
    const fences = result.text.split('```').length - 1;
    expect(fences % 2).toBe(0);
    expect(result.text).toContain(truncationPointer('PROJ-1'));
  });

  it('exposes the derived per-section budgets', () => {
    expect(SEED_BUDGETS).toEqual({
      ticketPrompt: 4000,
      gateSummary: 1000,
      findings: 2000,
      brief: 3000,
      attachments: 1500,
      approachMethod: 8000,
      testerCriteria: 8_000,
    });
  });
});
