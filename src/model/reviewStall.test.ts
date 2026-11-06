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
    expect(stall?.reason).toBe('Review keeps finding new problems in src/workflow/usageLimitRerun.ts (3 rounds).');
    expect(stall?.reason).not.toContain('design problem');
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
    expect(stall?.reason).toBe('Review keeps reporting the same problem at f2.ts (2 rounds). This is likely a design problem, not a bug.');
    expect(evaluateReviewStall([rep(1, 'A'), rep(2, 'B')], c)).toBeNull();
  });
  it('null identities never count as repeats', () => {
    const rep = (n: number): StallAttempt => ({ attempt: n, findings: [{ file: `f${n}.ts`, identity: null }] });
    expect(evaluateReviewStall([rep(1), rep(2)], { ...cfg, repeatedFindingRounds: 2 })).toBeNull();
  });

  describe('line-window repeat and clean rounds', () => {
    const at = (attempt: number, file: string, line: number | null, title: string): StallAttempt => ({
      attempt,
      findings: [{ file, line, identity: `id-${title}` }],
    });
    const rep = { ...cfg, sameFileRounds: 5, repeatedFindingRounds: 3 };
    const R = 'src/extension/ops/ratchet.ts';

    it('T991: lines 196, 193, 196 with reworded titles fire as a repeat', () => {
      const stall = evaluateReviewStall([at(1, R, 196, 'a'), at(2, R, 193, 'b'), at(3, R, 196, 'c')], rep);
      expect(stall?.repeat).toEqual({ file: R, line: 196 });
      expect(stall?.reason).toBe(
        `Review keeps reporting the same problem at ${R}:196 (3 rounds). This is likely a design problem, not a bug.`,
      );
    });
    it('T990: lines 98, 51, 72 of one file do not fire', () => {
      const F = 'src/ciLog.ts';
      expect(evaluateReviewStall([at(1, F, 98, 'a'), at(2, F, 51, 'b'), at(3, F, 72, 'c')], rep)).toBeNull();
    });
    it('the window is 15 lines inclusive', () => {
      expect(evaluateReviewStall([at(1, R, 100, 'a'), at(2, R, 115, 'b')], { ...rep, repeatedFindingRounds: 2 })).not.toBeNull();
      expect(evaluateReviewStall([at(1, R, 100, 'a'), at(2, R, 116, 'b')], { ...rep, repeatedFindingRounds: 2 })).toBeNull();
    });
    it('a finding with no line matches by identity only', () => {
      const c = { ...rep, repeatedFindingRounds: 2 };
      expect(evaluateReviewStall([at(1, R, null, 'a'), at(2, R, null, 'b')], c)).toBeNull();
      expect(evaluateReviewStall([at(1, R, null, 'a'), at(2, R, null, 'a')], c)?.reason).toContain(`at ${R} (2 rounds)`);
    });
    it('does not match across different files', () => {
      expect(evaluateReviewStall([at(1, 'a.ts', 10, 'a'), at(2, 'b.ts', 10, 'b')], { ...rep, repeatedFindingRounds: 2 })).toBeNull();
    });
    it('a repeat is off while repeatedFindingRounds is null', () => {
      expect(evaluateReviewStall([at(1, R, 196, 'a'), at(2, R, 196, 'b'), at(3, R, 196, 'c')], { ...rep, repeatedFindingRounds: null })).toBeNull();
    });
    it('a clean attempt breaks the same-file streak', () => {
      const clean: StallAttempt = { attempt: 3, findings: [] };
      const c = { ...cfg, sameFileRounds: 3 };
      expect(evaluateReviewStall([att(1, 'a.ts'), att(2, 'a.ts'), clean, att(4, 'a.ts')], c)).toBeNull();
      expect(evaluateReviewStall([att(1, 'a.ts'), att(2, 'a.ts'), att(3, 'a.ts'), clean], c)).toBeNull();
    });
    it('a clean attempt breaks a repeat', () => {
      const clean: StallAttempt = { attempt: 2, findings: [] };
      expect(evaluateReviewStall([at(1, R, 5, 'a'), clean, at(3, R, 5, 'a')], { ...rep, repeatedFindingRounds: 3 })).toBeNull();
    });
    it('a same-file streak never says design problem', () => {
      const stall = evaluateReviewStall([att(1, 'a.ts', 'b.ts'), att(2, 'a.ts', 'b.ts'), att(3, 'b.ts', 'a.ts')], { ...cfg });
      expect(stall?.reason).toBe('Review keeps finding new problems in a.ts, b.ts (3 rounds).');
    });
  });
});
