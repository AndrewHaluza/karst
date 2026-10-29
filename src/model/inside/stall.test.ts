import { describe, it, expect } from 'vitest';
import type { Finding } from '../../store/reviewFindings.js';
import { stallView } from './stall.js';

const f = (attempt: number, file: string, identity: string | null, severity: Finding['severity'] = 'high'): Finding => ({
  id: attempt * 100 + file.length,
  ticketId: 1,
  attempt,
  runAt: `2026-01-0${attempt}T00:00:00Z`,
  processRunId: null,
  severity,
  repo: '/web',
  file,
  line: 1,
  title: 't',
  detail: 'd',
  source: 'agent',
  createdAt: '',
  identity,
});
const cfg = { enabled: true, sameFileRounds: 3, repeatedFindingRounds: null };

describe('stallView', () => {
  it('is absent when disabled or nothing repeats', () => {
    expect(stallView([f(1, 'a.ts', 'x'), f(2, 'a.ts', 'y')], 'high', { ...cfg, enabled: false })).toBeUndefined();
    expect(stallView([f(1, 'a.ts', 'x'), f(2, 'b.ts', 'y')], 'high', cfg)).toBeUndefined();
    expect(stallView([], 'high', cfg)).toBeUndefined();
  });
  it('lists files hit in 2+ consecutive rounds, flags stalled at the threshold', () => {
    const rows = [f(1, 'a.ts', 'x'), f(2, 'a.ts', 'y'), f(2, 'b.ts', 'z')];
    expect(stallView(rows, 'high', cfg)).toEqual({
      stalled: false,
      rounds: 2,
      files: [{ file: 'a.ts', roundsHit: 2 }],
      repeatedIdentities: 0,
    });
    const three = [...rows, f(3, 'a.ts', 'w')];
    expect(stallView(three, 'high', cfg)).toMatchObject({ stalled: true, rounds: 3, files: [{ file: 'a.ts', roundsHit: 3 }] });
  });
  it('counts repeated identities across the latest two attempts', () => {
    const v = stallView([f(1, 'a.ts', 'same'), f(2, 'b.ts', 'same')], 'high', cfg);
    expect(v).toMatchObject({ stalled: false, files: [], repeatedIdentities: 1 });
  });
  it('ignores non-blocking findings', () => {
    expect(stallView([f(1, 'a.ts', 'x', 'low'), f(2, 'a.ts', 'y', 'low')], 'high', cfg)).toBeUndefined();
  });
});
