import type { Store } from '../../store/db.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';
import type { SyncSubtasksMode, TicketingConfig } from '../../manifest/types.js';
import { findTicketById, updateTicketFields } from '../../store/tickets.js';
import { getTicketSourceRef, listRelations, markWriteback } from '../../store/ticketRelations.js';

export interface SubtaskSyncDeps {
  store: Store;
  provider: () => TicketingProvider;
  /** Current `ticketing.syncSubtasks`; absent means `off`. */
  mode: () => SyncSubtasksMode | undefined;
  /** The ticket form's bind hook: resolves dangling refs and runs pending write-backs. */
  onSourceRefBound: (ticketId: number) => Promise<void>;
  debug: (message: string) => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Mirror a freshly created sub-task onto the provider (`ticketing.syncSubtasks`
 * `link`/`full`). The parent link is set only here, through `parentRef` at
 * creation. The blocked-by edge is NOT written here: binding the child's
 * `source_ref` lets the existing promotion + write-back push it. Never throws —
 * the sub-task already exists; a provider failure is recorded on the rows.
 */
export async function syncSubtaskToProvider(deps: SubtaskSyncDeps, childId: number): Promise<void> {
  const mode = deps.mode() ?? 'off';
  if (mode === 'off') {
    deps.debug(`[ticketing] sub-task sync #${childId}: mode off — recorded rows only`);
    return;
  }
  const child = findTicketById(deps.store, childId);
  if (!child || child.subtaskParentId === null) return;
  if ((child.sourceRef ?? '').trim() !== '') {
    deps.debug(`[ticketing] sub-task sync #${childId}: already bound — no second provider task`);
    return;
  }
  const parentRef = getTicketSourceRef(deps.store, child.subtaskParentId);
  if (parentRef === null) {
    deps.debug(`[ticketing] sub-task sync #${childId}: parent has no provider ref — skipping`);
    return;
  }
  const provider = deps.provider();
  if (!provider.createTicket) {
    deps.debug(`[ticketing] sub-task sync #${childId}: provider cannot create tickets — skipping`);
    return;
  }
  deps.debug(`[ticketing] sub-task sync #${childId}: creating provider task under '${parentRef}' (${mode})`);
  try {
    const created = await provider.createTicket({
      title: child.title ?? '',
      description: child.description ?? undefined,
      parentRef,
    });
    updateTicketFields(deps.store, childId, {
      sourceRef: created.ref,
      sourceRefInternal: created.internalRef ?? '',
    });
    if (created.ref.trim() !== '') await deps.onSourceRefBound(childId);
    deps.debug(`[ticketing] sub-task sync #${childId}: bound '${created.ref}'`);
  } catch (e) {
    const message = errorMessage(e);
    deps.debug(`[ticketing] sub-task sync #${childId}: failed — ${message}`);
    markFailed(deps.store, childId, child.subtaskParentId, message);
  }
}

/** Record the failure on every sub-task relation row between child and parent. */
function markFailed(store: Store, childId: number, parentId: number, message: string): void {
  for (const id of [childId, parentId]) {
    for (const row of listRelations(store, id)) {
      const between =
        (row.ticketId === childId && row.targetTicketId === parentId) ||
        (row.ticketId === parentId && row.targetTicketId === childId);
      if (between) markWriteback(store, row.id, 'failed', message);
    }
  }
}

export interface SubtaskSyncWiring {
  store: Store;
  ticketing: () => TicketingConfig | undefined;
  makeProvider: (ticketing: TicketingConfig | undefined) => TicketingProvider;
  onSourceRefBound: (deps: { store: Store; provider: TicketingProvider }, ticketId: number) => Promise<void>;
  debug: (message: string) => void;
}

/** The host binding: reads the CURRENT manifest per call so a Settings save applies at once. */
export function makeSubtaskSync(wiring: SubtaskSyncWiring): (childId: number) => Promise<void> {
  return (childId) => {
    const ticketing = wiring.ticketing();
    const provider = wiring.makeProvider(ticketing);
    return syncSubtaskToProvider(
      {
        store: wiring.store,
        provider: () => provider,
        mode: () => ticketing?.syncSubtasks,
        onSourceRefBound: (id) => wiring.onSourceRefBound({ store: wiring.store, provider }, id),
        debug: wiring.debug,
      },
      childId,
    );
  };
}
