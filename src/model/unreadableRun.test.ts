import { describe, expect, it } from 'vitest';
import { isUnreadableRun } from './unreadableRun.js';

describe('isUnreadableRun', () => {
  it('reads the recorded unreadable kind', () => {
    expect(isUnreadableRun({ resultKind: 'unreadable-output' })).toBe(true);
  });

  it('reads a legacy Review row: execution-failed with the unreadable sentence', () => {
    expect(
      isUnreadableRun({
        resultKind: 'execution-failed',
        failureDetail: 'unreadable output from /wt/web — no findings could be read',
      }),
    ).toBe(true);
  });

  it('matches the legacy sentence as a prefix, not a substring', () => {
    const detail = 'review findings: unreadable output from /wt/web — no findings could be read';
    expect(isUnreadableRun({ resultKind: 'execution-failed', failureDetail: detail })).toBe(true);
    expect(
      isUnreadableRun({ resultKind: 'execution-failed', failureDetail: 'crash: unreadable output from the log' }),
    ).toBe(false);
  });

  it('keeps a crash and a usage limit as failures', () => {
    expect(isUnreadableRun({ resultKind: 'execution-failed', failureDetail: 'spawn ENOENT' })).toBe(false);
    expect(
      isUnreadableRun({ resultKind: 'execution-failed', failureDetail: 'usage limit reached' }),
    ).toBe(false);
    expect(isUnreadableRun({ resultKind: 'execution-failed' })).toBe(false);
  });

  it('never reads another kind as unreadable', () => {
    expect(isUnreadableRun({ resultKind: 'validated' })).toBe(false);
    expect(isUnreadableRun({ resultKind: null })).toBe(false);
  });
});
