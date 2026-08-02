import { describe, it, expect } from 'vitest';
import type { GateRun } from '../../store/gateRuns.js';
import type { AggregateEntry } from '../uat/aggregate.js';
import {
  aggregateReview,
  malformedPackageJsonEntry,
  sameGateIdentity,
  uatIdentitiesFrom,
  type AggregateOutcome,
  type GateIdentity,
} from './aggregate.js';

const AT = '2026-08-01T10:00:00.000Z';

function entry(
  name: string,
  exitCode: number | null,
  invocation: { repo: string; command: string; args: string[] },
): AggregateEntry {
  return { result: { name, exitCode, output: '' }, identity: invocation };
}

const lintWeb = entry('lint (web)', 0, { repo: '/web', command: 'npm', args: ['run', 'lint'] });
const lintWebRed = entry('lint (web)', 1, { repo: '/web', command: 'npm', args: ['run', 'lint'] });
const testWeb = entry('test (web)', 0, { repo: '/web', command: 'npm', args: ['test'] });
const testWebRed = entry('test (web)', 2, { repo: '/web', command: 'npm', args: ['test'] });
const testWebSkipped = entry('test (web)', null, { repo: '/web', command: 'npm', args: ['test'] });
const malformedWeb = malformedPackageJsonEntry('/web', 'web', 'Unexpected token }', AT);

/** What UAT's latest recorded batch carries today: the gate name, nothing more. */
const uatRanTest: GateIdentity = { name: 'test (web)' };
const uatRanE2e: GateIdentity = { name: 'e2e (web)' };

const REQUIRED = { requireIndependentSignal: true };
const RELAXED = { requireIndependentSignal: false };

interface Case {
  rule: string;
  what: string;
  entries: AggregateEntry[];
  uat: GateIdentity[];
  opts: { requireIndependentSignal: boolean };
  expect: AggregateOutcome;
}

/**
 * R1–R9 of §6.4, as a table, in the order the chain must apply them.
 *
 * R1 (no target resolved) and R2 (a probe karst could not read) are decided
 * upstream in `stages/review.ts`, BEFORE a single entry exists — which is
 * exactly their precedence position, since they short-circuit before this
 * function is reached. `review.test.ts` owns their cases. R8 does not exist:
 * the human approval lane was dropped from this plan.
 */
const CASES: Case[] = [
  {
    rule: 'R3',
    what: 'zero gates ran across every target blocks nothing-to-run',
    entries: [testWebSkipped],
    uat: [],
    opts: REQUIRED,
    expect: {
      kind: 'blocked',
      blocker: 'nothing-to-run',
      reason: 'no gate ran: test (web)',
    },
  },
  {
    rule: 'R3',
    what: 'no entries at all blocks nothing-to-run',
    entries: [],
    uat: [],
    opts: REQUIRED,
    expect: {
      kind: 'blocked',
      blocker: 'nothing-to-run',
      reason: 'no gates resolved for this ticket',
    },
  },
  {
    rule: 'R4',
    what: 'a malformed package.json fails by name, agent-fixable',
    entries: [malformedWeb],
    uat: [],
    opts: REQUIRED,
    expect: {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: 'package.json is malformed — Unexpected token }' },
      warnings: [],
    },
  },
  {
    rule: 'R4 > R5',
    what: 'a malformed package.json outranks a red gate elsewhere',
    entries: [lintWebRed, malformedWeb],
    uat: [],
    opts: REQUIRED,
    expect: {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: 'package.json is malformed — Unexpected token }' },
      warnings: [],
    },
  },
  {
    rule: 'R5',
    what: 'any gate that ran and exited non-zero fails, naming the gates',
    entries: [lintWeb, testWebRed],
    uat: [uatRanE2e],
    opts: REQUIRED,
    expect: {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: 'gates failed: test (web)' },
      warnings: [],
    },
  },
  {
    rule: 'R5 > R7',
    what: 'a red gate outranks the independence rule, because a gate is cheaper to act on',
    entries: [testWebRed],
    uat: [uatRanTest],
    opts: REQUIRED,
    expect: {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: 'gates failed: test (web)' },
      warnings: [],
    },
  },
  {
    rule: 'R7',
    what: 'every effective identity duplicating UAT fails, naming the commands',
    entries: [testWeb],
    uat: [uatRanTest],
    opts: REQUIRED,
    expect: {
      kind: 'verdict',
      verdict: {
        kind: 'failed',
        reason: 'review asked no question uat does not: npm test',
      },
      warnings: [],
    },
  },
  {
    rule: 'R7',
    what: 'a declared-but-skipped gate buys no independence — only what RAN counts',
    entries: [testWeb, entry('e2e (web)', null, { repo: '/web', command: 'npm', args: ['run', 'e2e'] })],
    uat: [uatRanTest],
    opts: REQUIRED,
    expect: {
      kind: 'verdict',
      verdict: {
        kind: 'failed',
        reason: 'review asked no question uat does not: npm test',
      },
      warnings: [],
    },
  },
  {
    rule: 'R7',
    what: 'one independent identity is enough — review asked something new',
    entries: [lintWeb, testWeb],
    uat: [uatRanTest],
    opts: REQUIRED,
    expect: { kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] },
  },
  {
    rule: 'R7',
    what: 'an empty UAT batch cannot make review redundant',
    entries: [testWeb],
    uat: [],
    opts: REQUIRED,
    expect: { kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] },
  },
  {
    rule: 'R7',
    what: 'the config escape hatch turns the rule off entirely',
    entries: [testWeb],
    uat: [uatRanTest],
    opts: RELAXED,
    expect: { kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] },
  },
  {
    rule: 'R9',
    what: 'otherwise, passed',
    entries: [lintWeb, testWeb, testWebSkipped],
    uat: [uatRanE2e],
    opts: REQUIRED,
    expect: { kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] },
  },
];

describe('aggregateReview', () => {
  for (const c of CASES) {
    it(`${c.rule}: ${c.what}`, () => {
      expect(aggregateReview(c.entries, c.uat, c.opts)).toEqual(c.expect);
    });
  }

  it('mutates neither its entries nor the UAT identities it was given', () => {
    const entries = [lintWeb, testWebRed];
    const uat = [uatRanTest];
    const before = JSON.stringify({ entries, uat });
    aggregateReview(entries, uat, REQUIRED);
    expect(JSON.stringify({ entries, uat })).toBe(before);
  });

  // R6 (findings) is Tasks 11–13. There is no findings input yet, so the chain
  // must simply not match it — never a stubbed lane that could fail a ticket on
  // evidence nothing produces.
  it('R6: with no findings input the chain falls through it untouched', () => {
    expect(aggregateReview([lintWeb], [], REQUIRED)).toEqual({
      kind: 'verdict',
      verdict: { kind: 'passed' },
      warnings: [],
    });
  });
});

describe('sameGateIdentity', () => {
  it('compares the recorded name when one side carries nothing richer', () => {
    // All `gate_runs` carries today (Task 7 adds repo/command/args).
    expect(sameGateIdentity({ name: 'test (web)' }, { name: 'test (web)' })).toBe(true);
    expect(sameGateIdentity({ name: 'test (web)' }, { name: 'test (api)' })).toBe(false);
  });

  it('compares repository, command and args once BOTH sides carry them', () => {
    const a: GateIdentity = { name: 'test (web)', repo: '/web', command: 'npm', args: ['test'] };
    expect(sameGateIdentity(a, { ...a, name: 'suite (web)' })).toBe(true);
    expect(sameGateIdentity(a, { ...a, repo: '/api' })).toBe(false);
    expect(sameGateIdentity(a, { ...a, args: ['run', 'e2e'] })).toBe(false);
  });

  it('falls back to the name when only one side is enriched', () => {
    const rich: GateIdentity = { name: 'test (web)', repo: '/web', command: 'npm', args: ['test'] };
    expect(sameGateIdentity(rich, { name: 'test (web)' })).toBe(true);
    expect(sameGateIdentity(rich, { name: 'e2e (web)' })).toBe(false);
  });
});

describe('uatIdentitiesFrom', () => {
  let nextId = 1;
  function row(
    stageKey: 'uat' | 'review',
    gateName: string,
    exitCode: number | null,
    runAt: string,
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
    };
  }

  it("takes only UAT's latest batch, chosen by the greatest stamp", () => {
    // The stale batch sits LAST, so picking "the end of the array" would return
    // it — the store guarantees no row order, and an added index could reorder
    // these with nothing failing to say so.
    const runs = [
      row('uat', 'test (web)', 0, '2026-08-01T10:00:00.000Z'),
      row('uat', 'e2e (web)', 0, '2026-08-01T10:00:00.000Z'),
      row('uat', 'old (web)', 0, '2026-08-01T09:00:00.000Z'),
    ];
    expect(uatIdentitiesFrom(runs)).toEqual([{ name: 'test (web)' }, { name: 'e2e (web)' }]);
  });

  it("ignores another stage's rows", () => {
    expect(uatIdentitiesFrom([row('review', 'lint (web)', 0, AT)])).toEqual([]);
  });

  it('counts only the gates that RAN — a skipped one asked nothing', () => {
    expect(
      uatIdentitiesFrom([row('uat', 'test (web)', null, AT), row('uat', 'e2e (web)', 0, AT)]),
    ).toEqual([{ name: 'e2e (web)' }]);
  });

  it('has nothing to say when UAT never recorded a batch', () => {
    expect(uatIdentitiesFrom([])).toEqual([]);
  });
});
