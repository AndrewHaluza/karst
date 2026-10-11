import { SessionManager } from '../session.js';

/**
 * A `SessionManager` for tests that are not about the CLI env: `openSession`
 * refuses a launch with no CLI entry or DB path, so this fills them in unless
 * the test supplies its own.
 */
export class DefaultedSessionManager extends SessionManager {
  override openSession(...args: Parameters<SessionManager['openSession']>): void {
    const next = [...args] as typeof args;
    next[10] = { cliEntry: '/ext/dist/cli/main.js', dbPath: '/g/karst.db', ...(args[10] ?? {}) };
    super.openSession(...next);
  }
}
