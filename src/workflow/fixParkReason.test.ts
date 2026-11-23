import { describe, expect, it } from 'vitest';
import {
  PARK_NO_CHANGE_RERUN_FAILED,
  PARK_NO_NEW_COMMIT_ALREADY_RERAN,
  PARK_NO_NEW_COMMIT_RERUN_FAILED,
} from './fixHostRerun.js';
import { isHostParkReason } from './fixParkReason.js';
import { NO_CHANGE_SAME_HEAD_PREFIX } from './fixNoChange.js';

describe('the host park verdict prefixes', () => {
  it('names the leading text of each of the four park verdicts', () => {
    expect(PARK_NO_NEW_COMMIT_ALREADY_RERAN).toBe('no new commit, and the host already re-ran the failed gates');
    expect(PARK_NO_NEW_COMMIT_RERUN_FAILED).toBe('no new commit, and the host re-run did not close the round');
    expect(PARK_NO_CHANGE_RERUN_FAILED).toBe(
      'the agent found no change to make, and the re-run of the failed gates did not close the round',
    );
    expect(NO_CHANGE_SAME_HEAD_PREFIX).toBe('second no-change verdict on the same head');
  });

  it('matches each park verdict from its stored end reason', () => {
    expect(isHostParkReason(`${PARK_NO_NEW_COMMIT_ALREADY_RERAN} — the way out`)).toBe(true);
    expect(isHostParkReason(`${PARK_NO_NEW_COMMIT_RERUN_FAILED} — still fails — x. the way out`)).toBe(true);
    expect(isHostParkReason(`${PARK_NO_CHANGE_RERUN_FAILED} — still fails — x. the way out`)).toBe(true);
    expect(isHostParkReason(`${NO_CHANGE_SAME_HEAD_PREFIX} (no change: again) — the way out`)).toBe(true);
  });

  it('matches nothing else', () => {
    expect(isHostParkReason(null)).toBe(false);
    expect(isHostParkReason('')).toBe(false);
    expect(isHostParkReason('the host restarted during the re-run')).toBe(false);
    expect(isHostParkReason('no change: flaky port')).toBe(false);
    expect(isHostParkReason('no new commit, and the host')).toBe(false);
  });
});
