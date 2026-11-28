import { describe, expect, it } from 'vitest';
import type { AutofixAttempt, AutofixRound } from './autofix.js';
import { listShipRounds, shipRoundEvidence, shipRoundLedger, shipRoundWindows, type ShipRoundEvidenceFacts } from './shipRounds.js';

const NOW = '2026-11-09T12:00:00.000Z';
/** A time on 2026-11-09 at `hh:mm`. */
const t = (hhmm: string): string => `2026-11-09T${hhmm}:00.000Z`;
const ci = (n: number, max = 3, at = t(`09:0${n}`)): AutofixAttempt => ({ kind: 'ci', n, max, at });
const conflict = (n: number, max = 2, at = t(`09:0${n}`)): AutofixAttempt => ({ kind: 'conflicts', n, max, at });
const round = (kind: AutofixRound['kind'], used: number, max: number): AutofixRound => ({
  kind,
  repo: 'api',
  pr: 88,
  check: kind === 'ci' ? 'lint' : null,
  used,
  max,
});

describe('listShipRounds', () => {
  it('emits no tabs for a ticket with fewer than two rounds', () => {
    expect(listShipRounds({ attempts: [], liveRound: null, now: NOW })).toEqual([]);
    expect(listShipRounds({ attempts: [ci(1)], liveRound: null, now: NOW })).toEqual([]);
  });

  it('labels rounds across both kinds, tags the kind, and keys each by its note time', () => {
    const rounds = listShipRounds({ attempts: [conflict(1, 2, t('09:01')), ci(1, 3, t('09:10'))], liveRound: round('ci', 1, 3), now: NOW });
    expect(rounds.map((r) => [r.label, r.tag, r.key, r.tail, r.status, r.latest])).toEqual([
      ['R1', 'conflict', `ship:${t('09:01')}`, 'of 2', 'note', false],
      ['R2', 'CI', `ship:${t('09:10')}`, 'of 2 · live', 'run', true],
    ]);
  });

  it('orders by the note time, never by array position', () => {
    const rounds = listShipRounds({ attempts: [ci(2, 3, t('09:30')), conflict(1)], liveRound: null, now: NOW });
    expect(rounds.map((r) => r.key)).toEqual([`ship:${t('09:01')}`, `ship:${t('09:30')}`]);
  });

  it('never marks a round that only ran as passed: the newest finished round is note', () => {
    const rounds = listShipRounds({ attempts: [ci(1), ci(2), ci(3)], liveRound: null, now: NOW });
    expect(rounds.map((r) => r.status)).toEqual(['fail', 'fail', 'note']);
    expect(rounds.every((r) => r.status !== 'pass')).toBe(true);
  });

  it('fails the rounds a spent park names and warns no fix attempts left on the newest', () => {
    const rounds = listShipRounds({ attempts: [ci(1), ci(2), ci(3)], liveRound: null, spent: { kind: 'ci', used: 3 }, now: NOW });
    expect(rounds.map((r) => r.status)).toEqual(['fail', 'fail', 'fail']);
    expect(rounds.map((r) => r.warning)).toEqual([undefined, undefined, 'no fix attempts left']);
  });

  it('keeps an older, reset budget out of a spent park of the newest rounds', () => {
    const rounds = listShipRounds({ attempts: [ci(1), ci(2), ci(1), ci(2)], liveRound: null, spent: { kind: 'ci', used: 2 }, now: NOW });
    expect(rounds.map((r) => r.status)).toEqual(['note', 'note', 'fail', 'fail']);
  });

  it('carries the budget and why the round opened in the caption, and no duration', () => {
    const rounds = listShipRounds({ attempts: [conflict(1, 2, t('09:01')), ci(1, 3, t('09:10'))], liveRound: round('ci', 1, 3), now: NOW });
    expect(rounds[0]!.caption).toBe('conflict round 1 of 2 · opened by a merge conflict');
    expect(rounds[1]!.caption).toBe('CI round 1 of 3 · opened by a failing check');
    expect(rounds[1]!.caption).not.toMatch(/\d+(\.\d+)?s\b/);
  });
});

describe('shipRoundWindows', () => {
  it('covers [at_i, at_i+1) per round and [at_n, now) for the last', () => {
    const windows = shipRoundWindows({ attempts: [ci(2, 3, t('09:20')), conflict(1)], now: NOW });
    expect(windows).toEqual([
      { key: `ship:${t('09:01')}`, from: t('09:01'), to: t('09:20') },
      { key: `ship:${t('09:20')}`, from: t('09:20'), to: NOW },
    ]);
  });
});

describe('shipRoundEvidence', () => {
  // R1 and R2 are both CI rounds: the problem was still there when R2 opened.
  const attempts = [ci(1, 3, t('09:00')), ci(2, 3, t('09:30'))];
  const rounds = listShipRounds({ attempts, liveRound: null, now: NOW });
  const windows = shipRoundWindows({ attempts, now: NOW });

  const facts = (over: Partial<ShipRoundEvidenceFacts>): ShipRoundEvidenceFacts => ({
    round: rounds[0]!,
    attempt: attempts[0]!,
    ...over,
  });

  it('shows a finished round as one ran row with no result, then its pushes, then its CI result', () => {
    const rows = shipRoundEvidence(windows[0]!, facts({
      pushes: [
        { at: t('09:20'), label: 'api', detail: 'pushed', status: 'pass' },
        { at: t('09:05'), label: 'web', detail: 'pushed', status: 'pass' },
      ],
      followedByCi: true,
    }));
    expect(rows.map((r) => [r.label, r.status])).toEqual([
      ['round 1', 'note'],
      ['web', 'pass'],
      ['api', 'pass'],
      ['CI', 'fail'],
    ]);
    expect(rows[0]!.detail).toBe('CI round 1 of 3 ran');
    expect(rows[3]!.detail).toBe('CI still failed');
  });

  it('drops a push that starts outside the round window', () => {
    const rows = shipRoundEvidence(windows[0]!, facts({
      pushes: [
        { at: t('09:05'), label: 'web', detail: 'pushed', status: 'pass' },
        { at: t('09:30'), label: 'api', detail: 'pushed', status: 'pass' },
      ],
    }));
    expect(rows.map((r) => r.label)).toEqual(['round 1', 'web']);
  });

  it('invents no push row for a round with no push on record', () => {
    const rows = shipRoundEvidence(windows[1]!, {
      round: rounds[1]!,
      attempt: attempts[1]!,
      currentCi: { label: 'CI lint', status: 'pass' },
    });
    expect(rows.map((r) => [r.label, r.status])).toEqual([
      ['round 2', 'note'],
      ['CI lint', 'pass'],
    ]);
  });

  it('shows the live round’s steps and says the CI result waits for the push', () => {
    const live = listShipRounds({ attempts, liveRound: round('ci', 2, 3), now: NOW })[1]!;
    const rows = shipRoundEvidence(windows[1]!, {
      round: live,
      attempt: attempts[1]!,
      steps: [
        { label: 'fetch CI log', detail: 'gh · lint', status: 'pass' },
        { label: 'agent fix', detail: 'round 2', status: 'run', stopAfter: true },
      ],
    });
    expect(rows.map((r) => [r.label, r.status])).toEqual([
      ['fetch CI log', 'pass'],
      ['agent fix', 'run'],
      ['CI', 'pending'],
    ]);
    expect(rows[2]!.detail).toBe('waits for the push');
  });

  it('splits the same rows by the process that renders them', () => {
    const ledger = shipRoundLedger(windows[0]!, facts({
      pushes: [{ at: t('09:05'), label: 'web', detail: 'pushed', status: 'pass' }],
      followedByCi: true,
    }));
    expect(ledger.round).toBe(rounds[0]);
    expect(ledger.autofix.map((r) => r.label)).toEqual(['round 1']);
    expect(ledger.push.map((r) => r.label)).toEqual(['web']);
    expect(ledger.ci).toEqual([{ label: 'CI', detail: 'CI still failed', status: 'fail' }]);
    expect([...ledger.autofix, ...ledger.push, ...ledger.ci]).toEqual(
      shipRoundEvidence(windows[0]!, facts({
        pushes: [{ at: t('09:05'), label: 'web', detail: 'pushed', status: 'pass' }],
        followedByCi: true,
      })),
    );
  });
});
