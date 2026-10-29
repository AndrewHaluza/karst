import { describe, it, expect } from 'vitest';
import { evaluateReviewStall, type StallAttempt } from './reviewStall.js';

const att = (attempt: number, ...files: string[]): StallAttempt => ({
  attempt,
  findings: files.map((file, i) => ({ file, identity: `${file}#${attempt}-${i}` })),
});
const cfg = { enabled: true, sameFileRounds: 3, repeatedFindingRounds: null };

describe('evaluateReviewStall', () => {
  it('parks at attempt 3 when one file is hit in all three (D159 replay)', () => {
    const rounds = [
      att(1, 'src/workflow/usageLimitRerun.ts', 'a.ts'),
      att(2, 'src/workflow/usageLimitRerun.ts'),
      att(3, 'b.ts', 'src/workflow/usageLimitRerun.ts'),
    ];
    expect(evaluateReviewStall(rounds.slice(0, 2), cfg)).toBeNull();
    const stall = evaluateReviewStall(rounds, cfg);
    expect(stall?.rounds).toBe(3);
    expect(stall?.files.map((f) => f.file)).toEqual(['src/workflow/usageLimitRerun.ts']);
    expect(stall?.files[0]?.roundsHit).toBe(3);
    expect(stall?.reason).toContain('src/workflow/usageLimitRerun.ts (3 rounds)');
    expect(stall?.reason).toContain('likely a design problem');
  });
  it('never parks when findings move to different files', () => {
    expect(evaluateReviewStall([att(1, 'a.ts'), att(2, 'b.ts'), att(3, 'c.ts'), att(4, 'd.ts')], cfg)).toBeNull();
  });
  it('needs the SAME file in every one of the K attempts', () => {
    expect(evaluateReviewStall([att(1, 'a.ts'), att(2, 'a.ts', 'b.ts'), att(3, 'b.ts')], cfg)).toBeNull();
  });
  it('only the last K attempts count; counts the full streak in the reason', () => {
    const stall = evaluateReviewStall([att(1, 'x.ts'), att(2, 'a.ts'), att(3, 'a.ts'), att(4, 'a.ts'), att(5, 'a.ts')], cfg);
    expect(stall?.rounds).toBe(4);
  });
  it('disabled never stalls', () => {
    expect(evaluateReviewStall([att(1, 'a.ts'), att(2, 'a.ts'), att(3, 'a.ts')], { ...cfg, enabled: false })).toBeNull();
  });
  it('ignores findings without a file', () => {
    const rounds = [1, 2, 3].map((n) => ({ attempt: n, findings: [{ file: null, identity: 'x' }] }));
    expect(evaluateReviewStall(rounds, cfg)).toBeNull();
  });
  it('repeated identity stalls on its own threshold, with counts', () => {
    const rep = (n: number, id: string): StallAttempt => ({ attempt: n, findings: [{ file: `f${n}.ts`, identity: id }] });
    const c = { ...cfg, repeatedFindingRounds: 2 };
    const stall = evaluateReviewStall([rep(1, 'A'), rep(2, 'A')], c);
    expect(stall?.repeatedIdentities).toBe(1);
    expect(stall?.reason).toContain('same finding');
    expect(evaluateReviewStall([rep(1, 'A'), rep(2, 'B')], c)).toBeNull();
  });
  it('null identities never count as repeats', () => {
    const rep = (n: number): StallAttempt => ({ attempt: n, findings: [{ file: `f${n}.ts`, identity: null }] });
    expect(evaluateReviewStall([rep(1), rep(2)], { ...cfg, repeatedFindingRounds: 2 })).toBeNull();
  });
});
