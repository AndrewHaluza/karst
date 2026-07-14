import type { StageKey } from '../model/types.js';

/**
 * Resume an existing agent session only when continuing interactive work (impl
 * or fix) AND a session was captured (§5.3). Otherwise a fresh, fully-seeded
 * session is correct (scope/uat/review/ship have no interactive continuation).
 */
export function shouldResumeSession(t: { sessionId: string | null; stageCurrent: StageKey }): boolean {
  return t.sessionId !== null && (t.stageCurrent === 'impl' || t.stageCurrent === 'fix');
}
