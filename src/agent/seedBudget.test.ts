import { describe, it, expect } from 'vitest';
import { truncateToBudget, truncationPointer, SEED_BUDGETS } from './seedBudget.js';

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

  it('exposes the derived per-section budgets', () => {
    expect(SEED_BUDGETS).toEqual({
      ticketPrompt: 4000,
      gateSummary: 1000,
      findings: 2000,
      brief: 3000,
      attachments: 1500,
      approachMethod: 8000,
    });
  });
});
