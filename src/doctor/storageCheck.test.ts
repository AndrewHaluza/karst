import { describe, expect, it } from 'vitest';
import { formatDoctorBytes } from './formatBytes.js';
import { checkStorage, STORAGE_TOP_CHILDREN, STORAGE_WARN_BYTES, type StorageUsage } from './storageCheck.js';

const usage = (over: Partial<StorageUsage> = {}): StorageUsage => ({
  totalBytes: 0,
  entries: [],
  partial: false,
  ...over,
});

describe('checkStorage', () => {
  it('is ok under the limit and carries no fix', () => {
    const check = checkStorage(usage({ totalBytes: STORAGE_WARN_BYTES - 1 }));
    expect(check).toMatchObject({ id: 'state.storage', area: 'state', title: 'Karst storage', status: 'ok' });
    expect(check.detail).toBe(`Karst storage is ${formatDoctorBytes(STORAGE_WARN_BYTES - 1)}`);
    expect(check.fix).toBeUndefined();
  });

  it('warns AT the limit with a report-only fix naming the retention settings', () => {
    const check = checkStorage(usage({ totalBytes: STORAGE_WARN_BYTES }));
    expect(check.status).toBe('warn');
    expect(check.fix?.tier).toBe('report');
    expect(check.fix?.summary).toContain(formatDoctorBytes(STORAGE_WARN_BYTES));
    const nextStep = check.fix?.tier === 'report' ? check.fix.nextStep : '';
    expect(nextStep).toContain('archiveDoneAfterDays');
    expect(nextStep).toContain('archivePlanningAfterDays');
    expect(nextStep).toContain('artifacts.maxAgeDays');
  });

  it('warns above the limit too', () => {
    const check = checkStorage(usage({ totalBytes: STORAGE_WARN_BYTES * 2 }));
    expect(check.status).toBe('warn');
    expect(check.fix?.tier).toBe('report');
  });

  it('lists the five largest children in descending size order and omits the rest', () => {
    const check = checkStorage(
      usage({
        totalBytes: 21,
        entries: [
          { name: 'one', bytes: 1 },
          { name: 'two', bytes: 2 },
          { name: 'three', bytes: 3 },
          { name: 'four', bytes: 4 },
          { name: 'five', bytes: 5 },
          { name: 'six', bytes: 6 },
        ],
      }),
    );
    expect(check.detail).toBe(
      `Karst storage is 21 B (six 6 B, five 5 B, four 4 B, three 3 B, two 2 B)`,
    );
    expect(check.detail).not.toContain('one');
    expect(STORAGE_TOP_CHILDREN).toBe(5);
  });

  it('breaks size ties by name so the order is deterministic', () => {
    const check = checkStorage(
      usage({
        totalBytes: 10,
        entries: [
          { name: 'b', bytes: 5 },
          { name: 'a', bytes: 5 },
        ],
      }),
    );
    expect(check.detail).toBe('Karst storage is 10 B (a 5 B, b 5 B)');
  });

  it('renders clean detail without parentheses when there are no children', () => {
    const check = checkStorage(usage({ totalBytes: 0 }));
    expect(check.detail).toBe('Karst storage is 0 B');
    expect(check.detail).not.toContain('(');
  });

  it('shows partial only when the walk stopped early', () => {
    const entries = [{ name: 'artifacts', bytes: 2048 }];
    expect(checkStorage(usage({ totalBytes: 2048, entries, partial: true })).detail).toBe(
      'Karst storage is 2.0 KB (artifacts 2.0 KB) (partial)',
    );
    expect(checkStorage(usage({ totalBytes: 2048, entries, partial: false })).detail).toBe(
      'Karst storage is 2.0 KB (artifacts 2.0 KB)',
    );
  });
});
