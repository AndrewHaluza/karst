import { describe, it, expect, vi } from 'vitest';
import { parseStageArgs, runStageCommand } from './stage.js';
import type { Store } from '../store/db.js';

describe('parseStageArgs', () => {
  it('parses "stage impl pass" into a passed verdict', () => {
    expect(parseStageArgs(['stage', 'impl', 'pass'])).toEqual({
      stage: 'impl',
      verdict: { kind: 'passed' },
    });
  });

  it('parses "stage uat fail" into a failed verdict', () => {
    expect(parseStageArgs(['stage', 'uat', 'fail'])).toEqual({
      stage: 'uat',
      verdict: { kind: 'failed' },
    });
  });

  it('carries an optional fail reason', () => {
    expect(parseStageArgs(['stage', 'review', 'fail', 'lint broke'])).toEqual({
      stage: 'review',
      verdict: { kind: 'failed', reason: 'lint broke' },
    });
  });

  it('rejects an unknown stage key', () => {
    expect(() => parseStageArgs(['stage', 'nope', 'pass'])).toThrow();
  });

  it('rejects an unknown verdict word', () => {
    expect(() => parseStageArgs(['stage', 'uat', 'maybe'])).toThrow();
  });

  it('rejects a missing verdict', () => {
    expect(() => parseStageArgs(['stage', 'uat'])).toThrow();
  });
});

describe('runStageCommand', () => {
  it('calls transition with the parsed stage + verdict', () => {
    const transition = vi.fn().mockReturnValue('uat');
    const store = {} as Store;
    const next = runStageCommand(store, 42, ['stage', 'impl', 'pass'], transition);
    expect(transition).toHaveBeenCalledWith(store, 42, 'impl', { kind: 'passed' });
    expect(next).toBe('uat');
  });
});
