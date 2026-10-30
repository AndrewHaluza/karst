import { dirname, join } from 'node:path';

import { createArtifactStore } from '../artifacts/store.js';
import { findTicketById } from '../store/tickets.js';
import type { Store } from '../store/db.js';

/**
 * `karst artifact show <treePath>` — prints the newest revision of an artifact
 * from the calling ticket's artifact store (e.g. `_karst/alignment/intent-spec.md`,
 * which exists only there, never in a worktree). Read-only; same narrow argv
 * model as `artifact add` (arch:CLI-02): exactly one path, nothing trailing.
 */
export function parseArtifactShowArgs(argv: string[]): { path: string } {
  const [cmd, sub, path, ...extra] = argv;
  if (cmd !== 'artifact' || sub !== 'show') throw new Error("expected 'artifact show <treePath>'");
  if (path === undefined || path === '' || path.startsWith('--') || path.includes('\0')) {
    throw new Error('missing or invalid path (want `artifact show <treePath>`)');
  }
  if (extra.length > 0) {
    throw new Error(`unexpected argument '${extra[0]}' — artifact show takes a path only`);
  }
  return { path };
}

export async function runArtifactShowCommand(
  store: Store,
  ticketId: number,
  dbPath: string,
  argv: string[],
): Promise<string> {
  const { path } = parseArtifactShowArgs(argv);
  const ticket = findTicketById(store, ticketId);
  if (!ticket || ticket.projectId === null) throw new Error('ticket has no project — no artifacts stored');
  const artifacts = createArtifactStore({
    artifactsRoot: join(dirname(dbPath), 'artifacts'),
    projectId: ticket.projectId,
  });
  const newest = (await artifacts.history(ticketId, path))[0];
  if (!newest) throw new Error(`no artifact '${path}' in this ticket's store`);
  return (await artifacts.show(ticketId, newest.sha, path)).toString('utf8');
}
