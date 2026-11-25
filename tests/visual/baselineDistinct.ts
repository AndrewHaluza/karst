/**
 * Variant distinctness (@ui:VISUAL-VARIANTS, @ui:UI-R57): two registry variants that record the same PNG in one theme
 * project prove nothing the other does not. A collision passes only when one allow-list entry names every member of
 * the group, with a reason. An entry whose members no longer share one picture in any theme is stale and also fails,
 * so the list only shrinks. The same picture in two theme folders is one variant in two projects, never a collision.
 */
export interface BaselineShot {
  readonly theme: string;
  /** Baseline stem: the PNG file name without `.png`. */
  readonly baseline: string;
  readonly hash: string;
}

export interface AllowedCollision {
  /** Baseline stems that may record the same picture. */
  readonly baselines: readonly string[];
  readonly reason: string;
}

export interface CollisionReport {
  /** `theme: a = b` for each group no allow-list entry covers. */
  readonly unexpected: readonly string[];
  /** `a = b` for each allow-list entry whose members no longer collide. */
  readonly stale: readonly string[];
}

interface CollisionGroup {
  readonly theme: string;
  readonly members: readonly string[];
}

function collisionGroups(shots: readonly BaselineShot[]): readonly CollisionGroup[] {
  const byPicture = new Map<string, CollisionGroup>();
  for (const s of shots) {
    const key = `${s.theme}\0${s.hash}`;
    const prior = byPicture.get(key)?.members ?? [];
    byPicture.set(key, { theme: s.theme, members: prior.includes(s.baseline) ? prior : [...prior, s.baseline] });
  }
  return [...byPicture.values()]
    .filter((g) => g.members.length > 1)
    .map((g) => ({ theme: g.theme, members: [...g.members].sort() }));
}

export function baselineCollisions(shots: readonly BaselineShot[], allow: readonly AllowedCollision[]): CollisionReport {
  const groups = collisionGroups(shots);
  const unexpected = groups
    .filter((g) => !allow.some((entry) => g.members.every((m) => entry.baselines.includes(m))))
    .map((g) => `${g.theme}: ${g.members.join(' = ')}`)
    .sort();
  const stale = allow
    .filter((entry) => !groups.some((g) => entry.baselines.every((b) => g.members.includes(b))))
    .map((entry) => [...entry.baselines].sort().join(' = '));
  return { unexpected, stale };
}
