import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listTestHooks } from './testMode.js';
import { parseFlags, type TestFlags } from './flags.js';

/**
 * `karst test get-state` — the full DB snapshot a test needs to eyeball or diff
 * a ticket's state: the ticket itself, every stage row, any stage blocks, gate
 * runs, PR rows and the hook events the driver dispatched. Pure READ over the
 * store's own helpers, so the shape can't drift from what the UI renders.
 */

export function parseGetStateArgs(argv: string[]): void {
  parseFlags(argv); // accepts --json; validated for a well-formed line
}

export function runGetState(store: Store, ticketId: number): string {
  const ticket = getTicket(store, ticketId);
  const gates = listGateRuns(store, ticketId);
  const prs = store.db
    .prepare(
      `SELECT repo, number, url, status, head_ref, base_ref, merged_at
         FROM prs WHERE ticket_id = ? ORDER BY rowid`,
    )
    .all(ticketId) as Array<{
    repo: string;
    number: number | null;
    url: string | null;
    status: string | null;
    head_ref: string | null;
    base_ref: string | null;
    merged_at: string | null;
  }>;
  const hooks = listTestHooks(store, ticketId);

  const state = {
    ticket: {
      id: ticket.id,
      key: ticket.key,
      stageCurrent: ticket.stageCurrent,
      agentState: ticket.agentState,
    },
    stages: ticket.stages.map((s) => ({
      stageKey: s.stageKey,
      status: s.status,
      attempt: s.attempt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    })),
    blocks: ticket.stages
      .filter((s) => s.blockedKind !== null)
      .map((s) => ({
        stageKey: s.stageKey,
        kind: s.blockedKind,
        reason: s.blockedReason,
        at: s.blockedAt,
      })),
    gateRuns: gates.map((g) => ({
      id: g.id,
      stage: g.stageKey,
      gate: g.gateName,
      exitCode: g.exitCode,
      attempt: g.attempt,
      runAt: g.runAt,
    })),
    prs: prs.map((p) => ({
      repo: p.repo,
      number: p.number,
      url: p.url,
      status: p.status,
      headRef: p.head_ref,
      baseRef: p.base_ref,
      mergedAt: p.merged_at,
    })),
    hookEvents: hooks.map((h) => ({
      event: h.event,
      sessionId: h.sessionId,
      receivedAt: h.recordedAt,
      agentState: h.agentStateAfter,
    })),
  };
  return JSON.stringify(state, null, 2);
}
