import type { Store } from '../store/db.js';
import { setStage } from '../store/stages.js';
import { createTicket, setStageCurrent, updateTicketFields } from '../store/tickets.js';
import type { FixtureSpec } from './fixtures.js';

export function seedStore(store: Store, spec: FixtureSpec): number[] {
  return spec.tickets.map((seed) => {
    const ticket = createTicket(store, { key: seed.key, title: seed.title });
    setStageCurrent(store, ticket.id, seed.stageCurrent);
    if (seed.selectedRepos) updateTicketFields(store, ticket.id, { selectedRepos: seed.selectedRepos });
    if (seed.stage) setStage(store, ticket.id, seed.stage.stageKey, seed.stage.patch);
    return ticket.id;
  });
}
