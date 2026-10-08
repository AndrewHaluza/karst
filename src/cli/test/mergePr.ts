import type { Store } from '../../store/db.js';
import { listCurrentPrsByTicket, updatePrDetail } from '../../store/prs.js';
import { UNKNOWN_PR_DETAIL } from '../../integrations/github.js';
import { settleShipGate } from '../../workflow/mergeGate.js';
import { nowIso } from '../../model/time.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test merge-pr` — flip a ticket's CURRENT PR for a repo to `merged`
 * (the state `prSync` would report once a human landed it) and then settle the
 * ship gate, exactly the way the per-repo Merge click does. If every PR is now
 * merged, `settleShipGate` walks the ticket from `ship` to `done`; a ticket not
 * parked at ship (or not blocked awaiting-merge) stays where it is.
 *
 * Routed through `updatePrDetail` (not a raw SQL write) so the test path
 * exercises the SAME merge hook a real probe fires: the fake sha makes
 * `recordTicketMerged` write the host-fact bulletin note and stamp the ticket's
 * agent notes, and the fake changed paths give relevance something to match on.
 */

/** A deterministic fake merge sha — the hook only needs a non-null string. */
export const TEST_MERGE_SHA = 'test-merge-sha';
/** Fake repo-relative paths for the hook's stamping. */
export const TEST_MERGE_PATHS = ['src/'];

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
  updatePrDetail(store, {
    ticketId,
    repo: parsed.repo,
    url: current.url,
    detail: {
      ...UNKNOWN_PR_DETAIL,
      status: 'merged',
      mergedAt: nowIso(),
      mergeSha: TEST_MERGE_SHA,
      changedPaths: TEST_MERGE_PATHS,
    },
  });
  const result = settleShipGate(store, ticketId);
  return JSON.stringify({
    repo: parsed.repo,
    number: current.number,
    status: 'merged',
    advanced: result.advanced,
  });
}
