import type { Store } from '../../store/db.js';
import { listCurrentPrsByTicket } from '../../store/prs.js';
import { settleShipGate } from '../../workflow/mergeGate.js';
import { nowIso } from '../../model/time.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test merge-pr` — flip a ticket's CURRENT PR for a repo to `merged`
 * (the state `prSync` would report once a human landed it) and then settle the
 * ship gate, exactly the way the per-repo Merge click does. If every PR is now
 * merged, `settleShipGate` walks the ticket from `ship` to `done`; a ticket not
 * parked at ship (or not blocked awaiting-merge) stays where it is.
 */

export interface ParsedMergePr {
  repo: string;
}

export function parseMergePrArgs(argv: string[]): ParsedMergePr {
  const flags: TestFlags = parseFlags(argv);
  return { repo: requireFlag(flags, 'repo') };
}

export function runMergePr(store: Store, ticketId: number, parsed: ParsedMergePr): string {
  const current = listCurrentPrsByTicket(store, ticketId).find(
    (p) => p.repo === parsed.repo,
  );
  if (current === undefined) {
    throw new Error(
      `no PR row for repo '${parsed.repo}' on ticket ${ticketId} (open one first with 'karst test open-pr')`,
    );
  }
  store.db
    .prepare('UPDATE prs SET status = ?, merged_at = ? WHERE ticket_id = ? AND repo = ? AND url = ?')
    .run('merged', nowIso(), ticketId, parsed.repo, current.url);
  const result = settleShipGate(store, ticketId);
  return JSON.stringify({
    repo: parsed.repo,
    number: current.number,
    status: 'merged',
    advanced: result.advanced,
  });
}
