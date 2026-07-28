import type { StageKey } from '../model/types.js';
import type { AgentProvider } from '../manifest/types.js';

/**
 * Resume an existing agent session only when continuing interactive work (impl
 * or fix), a session was captured (§5.3), AND that session belongs to the agent
 * core this launch will actually use. Otherwise a fresh, fully-seeded session is
 * correct (scope/uat/review/ship have no interactive continuation).
 *
 * The provider check is the load-bearing one: a session id is private to the CLI
 * that minted it (Claude's conversation store vs. Codex's rollouts), so resuming
 * across a core switch hands the new CLI an id it cannot find and the launch dies
 * immediately — the terminal flashes open and exits nonzero. The switch can come
 * from the ticket's own override OR from the manifest default moving underneath
 * an inheriting ticket, so the comparison is against the RESOLVED provider rather
 * than against any single stored field.
 *
 * `sessionProvider === null` means the tag is unknown (a row captured before the
 * column existed, or a capture with no resolver): unprovable, so never resumed.
 */
export function shouldResumeSession(t: {
  sessionId: string | null;
  sessionProvider: AgentProvider | null;
  stageCurrent: StageKey;
  provider: AgentProvider;
}): boolean {
  if (t.sessionId === null || t.sessionProvider === null) return false;
  if (t.sessionProvider !== t.provider) return false;
  return t.stageCurrent === 'impl' || t.stageCurrent === 'fix';
}
