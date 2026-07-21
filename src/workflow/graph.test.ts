import { describe, it, expect } from 'vitest';
import { STAGE_KEYS } from '../model/types.js';
import { STAGE_GRAPH, MAIN_LINE, isBranch, isTerminal, needsConfirm } from './graph.js';

describe('branch stages', () => {
  it('fix is a branch — nothing reaches it except a failed verdict', () => {
    expect(isBranch('fix')).toBe(true);
  });

  it('a gate is not a branch, even though it can fail', () => {
    // uat and review route failures INTO the loop; they are still steps on the
    // forward path, reached by a passing verdict.
    expect(isBranch('uat')).toBe(false);
    expect(isBranch('review')).toBe(false);
  });

  it('the entry stage is not a branch, despite having no inbound edge at all', () => {
    // scope is reached by nothing — it is where a ticket starts. Classifying
    // "no inbound passed edge" as a branch would push it off the rail.
    expect(isBranch('scope')).toBe(false);
  });

  it('MAIN_LINE is STAGE_KEYS minus the branches, in order', () => {
    expect(MAIN_LINE).toEqual(STAGE_KEYS.filter((k) => !isBranch(k)));
    expect(MAIN_LINE).toEqual(['scope', 'impl', 'uat', 'review', 'ship', 'done']);
  });

  it('every stage is either on the main line or a branch, never neither', () => {
    for (const key of STAGE_KEYS) {
      expect(MAIN_LINE.includes(key) || isBranch(key), `unplaced stage: ${key}`).toBe(true);
    }
  });

  it('ship is the confirm stage — it cannot start without the user', () => {
    expect(needsConfirm('ship')).toBe(true);
  });

  it('no agent-driven stage is a confirm stage', () => {
    // The acceptance line: a stage that runs on its own must never claim to be
    // waiting on the user, or "Needs you" means nothing.
    for (const key of ['scope', 'impl', 'uat', 'review', 'fix'] as const) {
      expect(needsConfirm(key), `${key} must not require confirmation`).toBe(false);
    }
  });

  it('a confirm stage is never terminal — confirming is what moves it on', () => {
    for (const key of STAGE_KEYS) {
      expect(needsConfirm(key) && isTerminal(key), `${key} cannot be both`).toBe(false);
    }
  });

  it('is derived from STAGE_GRAPH, not from a hand-kept list', () => {
    // Every main-line stage after the entry must be reachable by a passing
    // verdict; that is the property MAIN_LINE encodes.
    const reachedByPass = new Set(
      Object.values(STAGE_GRAPH)
        .map((e) => e.passed)
        .filter((s): s is NonNullable<typeof s> => s !== undefined),
    );
    for (const key of MAIN_LINE.slice(1)) {
      expect(reachedByPass.has(key), `${key} is on the rail but no pass reaches it`).toBe(true);
    }
  });
});
