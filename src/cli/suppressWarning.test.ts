import { describe, it, expect, vi } from 'vitest';
import { installSqliteWarningFilter } from './suppressWarning.js';

interface FakeProc {
  emitWarning: (warning: string | Error, ...args: unknown[]) => void;
}

function fakeProc(): { proc: FakeProc; seen: unknown[] } {
  const seen: unknown[] = [];
  const proc: FakeProc = {
    emitWarning: vi.fn((warning: string | Error, ...args: unknown[]) => {
      seen.push({ warning, args });
    }),
  };
  return { proc, seen };
}

describe('installSqliteWarningFilter', () => {
  it('drops the node:sqlite ExperimentalWarning (string shape)', () => {
    const { proc, seen } = fakeProc();
    installSqliteWarningFilter(proc);
    proc.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    expect(seen).toHaveLength(0);
  });

  it('drops the warning when passed as an Error', () => {
    const { proc, seen } = fakeProc();
    installSqliteWarningFilter(proc);
    const err = new Error('SQLite is an experimental feature and might change at any time');
    err.name = 'ExperimentalWarning';
    proc.emitWarning(err);
    expect(seen).toHaveLength(0);
  });

  it('passes through other ExperimentalWarnings', () => {
    const { proc, seen } = fakeProc();
    installSqliteWarningFilter(proc);
    proc.emitWarning('Some other experimental thing', 'ExperimentalWarning');
    expect(seen).toHaveLength(1);
  });

  it('passes through non-experimental warnings with the same text', () => {
    const { proc, seen } = fakeProc();
    installSqliteWarningFilter(proc);
    proc.emitWarning('SQLite is an experimental feature', 'DeprecationWarning');
    expect(seen).toHaveLength(1);
  });

  it('preserves the extra arguments of a passed-through warning', () => {
    const { proc, seen } = fakeProc();
    installSqliteWarningFilter(proc);
    proc.emitWarning('careful', 'OtherWarning', 'CODE');
    expect(seen[0]).toEqual({ warning: 'careful', args: ['OtherWarning', 'CODE'] });
  });
});
