import { describe, it, expect } from 'vitest';
import type { GateRun } from '../../store/gateRuns.js';
import {
  aggregateUat,
  reviewIdentitiesFrom,
  sameIdentity,
  type AggregateEntry,
  type GateIdentity,
} from './aggregate.js';

const npmTest: GateIdentity = { repo: '/web', command: 'npm', args: ['test'] };
const npmE2e: GateIdentity = { repo: '/web', command: 'npm', args: ['run', 'e2e'] };

function entry(name: string, exitCode: number | null, identity: GateIdentity): AggregateEntry {
  return { result: { name, exitCode, output: '' }, identity };
}

describe('aggregateUat', () => {
  it('passes when every gate that ran exits 0 and one identity is independent', () => {
    const out = aggregateUat([entry('e2e', 0, npmE2e)], [npmTest]);
    expect(out).toEqual({ kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] });
  });

  it('fails when any gate that ran exits non-zero, naming the gates', () => {
    const out = aggregateUat(
      [entry('test', 0, npmTest), entry('e2e', 2, npmE2e)],
      [npmTest],
    );
    expect(out).toEqual({
      kind: 'verdict',
      verdict: { kind: 'failed', reason: 'gates failed: e2e' },
      warnings: [],
    });
  });

  it('a null gate neither passes nor fails — it says nothing', () => {
    const out = aggregateUat([entry('test', 0, npmTest), entry('e2e', null, npmE2e)], []);
    expect(out).toMatchObject({ kind: 'verdict', verdict: { kind: 'passed' } });
  });

  // The rule rev 2 got right per-gate and then lost at the aggregate level.
  it('every gate null is NOT a pass — it blocks nothing-to-run', () => {
    const out = aggregateUat([entry('test', null, npmTest)], []);
    expect(out).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
  });

  it('no gates at all blocks nothing-to-run', () => {
    expect(aggregateUat([], [])).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
  });

  // Phase 1 warns rather than blocking: the escape hatch is authored steps, which
  // are Phase 2, so blocking here would park every zero-config repository —
  // karst's own included — permanently, with no configuration that clears it.
  it('warns, does not block, when no effective identity is independent of review', () => {
    const out = aggregateUat([entry('test', 0, npmTest)], [npmTest]);
    expect(out.kind).toBe('verdict');
    if (out.kind !== 'verdict') return;
    expect(out.verdict).toEqual({ kind: 'passed' });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('npm test');
  });

  it('compares identities that RAN, so a declared-but-null probe buys nothing', () => {
    // e2e is declared and never ran; the only effective identity is npm test,
    // which review also runs. An explicit `uat.gates: [test]` recreates the
    // original bug exactly and must be caught here, not by a name ban.
    const out = aggregateUat(
      [entry('test', 0, npmTest), entry('e2e', null, npmE2e)],
      [npmTest],
    );
    expect(out.kind === 'verdict' && out.warnings).toHaveLength(1);
  });

  it('compares repository too, so the same command in another repo is independent', () => {
    const out = aggregateUat(
      [entry('test', 0, { repo: '/api', command: 'npm', args: ['test'] })],
      [npmTest],
    );
    expect(out.kind === 'verdict' && out.warnings).toEqual([]);
  });
});

describe('sameIdentity', () => {
  it('compares repository, command and args exactly', () => {
    expect(sameIdentity(npmTest, { ...npmTest })).toBe(true);
    expect(sameIdentity(npmTest, npmE2e)).toBe(false);
    expect(sameIdentity(npmTest, { ...npmTest, repo: '/api' })).toBe(false);
  });
});

describe('reviewIdentitiesFrom', () => {
  let nextId = 1;
  const AT = '2026-08-01T10:00:00.000Z';
  function row(
    stageKey: 'uat' | 'review',
    gateName: string,
    exitCode: number | null,
    runAt: string,
    identity: { repo: string | null; command: string | null; args: string[] | null } = {
      repo: null,
      command: null,
      args: null,
    },
  ): GateRun {
    return {
      id: nextId++,
      ticketId: 1,
      stageKey,
      attempt: 0,
      runAt,
      gateName,
      exitCode,
      startedAt: null,
      endedAt: null,
      ...identity,
    };
  }

  it("reads review's latest recorded batch, chosen by the greatest stamp — not a fixed gate list", () => {
    // The stale batch sits LAST; picking "the end of the array" would return
    // it, exactly like `uatIdentitiesFrom`'s own guard against array order.
    const runs = [
      row('review', 'lint (web)', 0, AT, { repo: '/web', command: 'npm', args: ['run', 'lint'] }),
      row('review', 'old (web)', 0, '2026-08-01T09:00:00.000Z', {
        repo: '/web',
        command: 'npm',
        args: ['run', 'old'],
      }),
    ];
    expect(reviewIdentitiesFrom(runs)).toEqual([{ repo: '/web', command: 'npm', args: ['run', 'lint'] }]);
  });

  it("ignores another stage's rows", () => {
    expect(
      reviewIdentitiesFrom([row('uat', 'test (web)', 0, AT, { repo: '/web', command: 'npm', args: ['test'] })]),
    ).toEqual([]);
  });

  it('counts only the gates that RAN — a skipped one asked nothing', () => {
    expect(
      reviewIdentitiesFrom([
        row('review', 'lint (web)', null, AT, { repo: '/web', command: 'npm', args: ['run', 'lint'] }),
        row('review', 'build (web)', 0, AT, { repo: '/web', command: 'npm', args: ['run', 'build'] }),
      ]),
    ).toEqual([{ repo: '/web', command: 'npm', args: ['run', 'build'] }]);
  });

  it('has nothing to say when review never recorded a batch', () => {
    expect(reviewIdentitiesFrom([])).toEqual([]);
  });

  // Unlike review's own `uatIdentitiesFrom`, this module's `GateIdentity` has no
  // name-only degradation — repo/command/args are all required — so a row
  // recorded before the v21 identity columns existed contributes no identity
  // at all rather than a guessed one.
  it('drops a row with no v21 identity rather than guessing one', () => {
    expect(reviewIdentitiesFrom([row('review', 'lint (web)', 0, AT)])).toEqual([]);
  });
});
