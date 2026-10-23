import { describe, it, expect } from 'vitest';
import { laneTargetsToAsk, notRunRepos, NOT_RUN } from './usageLimitKept.js';

describe('notRunRepos', () => {
  it('names the targets after the exhausted one that were never asked', () => {
    expect(
      notRunRepos(
        [{ repo: 'api' }, { repo: 'web' }, { repo: 'worker' }],
        [{ repo: 'api' }],
        'web',
      ),
    ).toEqual(['worker']);
  });

  it('names every target when the first one is the exhausted one', () => {
    expect(
      notRunRepos([{ repo: 'api' }, { repo: 'web' }], [], 'api'),
    ).toEqual(['web']);
  });

  it('never names a target twice, even when the plan repeats one', () => {
    expect(
      notRunRepos(
        [{ repo: 'api' }, { repo: 'api' }, { repo: 'web' }],
        [],
        'api',
      ),
    ).toEqual(['web']);
  });
});

describe('laneTargetsToAsk', () => {
  it('asks the parked target and every target the lane never reached', () => {
    expect(
      laneTargetsToAsk(
        [
          { repo: 'api', status: 'ok' },
          { repo: 'web', status: 'usage-limited' },
          { repo: 'worker', status: NOT_RUN },
        ],
        'web',
      ),
    ).toEqual(['web', 'worker']);
  });

  it('never asks a target that already answered', () => {
    expect(
      laneTargetsToAsk([{ repo: 'api', status: 'ok' }], 'web'),
    ).toEqual(['web']);
  });

  it('asks the parked target once, even when the kept outcome names it as not-run', () => {
    expect(laneTargetsToAsk([{ repo: 'web', status: NOT_RUN }], 'web')).toEqual(['web']);
  });
});
