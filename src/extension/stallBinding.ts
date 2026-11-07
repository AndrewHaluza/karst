import type { AgentAdapter } from '../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../agent/processAssignment.js';
import type { GitRunner } from '../integrations/git.js';
import { REVIEW_FINDINGS_DEFAULTS } from '../manifest/qualityDefaults.js';
import type { Manifest } from '../manifest/types.js';
import type { Store } from '../store/db.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { generateStallSuggestion } from '../workflow/stallSuggestion.js';
import type { StallHost } from './dashboardActions.js';
import { readTicketDiff } from './ops/stallDiff.js';
import { createStallSuggestionService, type StallSuggestionService } from './ops/stallSuggestionService.js';

/** What the binding needs from the extension host (T1001, @arch:REVIEW-STALL). */
export interface StallBindingDeps {
  store: Store;
  git: GitRunner;
  manifest: () => Manifest | undefined;
  /** The `stall-suggestion` process, or null when it is off. */
  processFor: (ticketId: number) => { adapter: AgentAdapter; assignment: ProcessAssignmentSnapshot } | null;
  refresh: (ticketId: number) => void;
  startPlanning: (title: string, kickoff: string) => Promise<unknown>;
  debug: (message: string) => void;
}

export interface StallBinding {
  service: StallSuggestionService;
  /** The per-ticket host the dashboard actions use. */
  hostFor: (ticketId: number) => StallHost;
}

export function createStallBinding(deps: StallBindingDeps): StallBinding {
  const severity = () => deps.manifest()?.review?.findings?.blockingSeverity ?? REVIEW_FINDINGS_DEFAULTS.blockingSeverity;
  const diffOf = (id: number) => readTicketDiff(deps.git, listWorktreesByTicket(deps.store, id));
  const service = createStallSuggestionService({
    store: deps.store,
    readDiff: diffOf,
    generate: async (id, parkAt, diff, retry) => {
      const process = deps.processFor(id);
      if (process === null) return 'skipped';
      return generateStallSuggestion({
        store: deps.store, ticketId: id, diff, blockingSeverity: severity(),
        adapter: process.adapter, assignment: process.assignment,
        cwd: listWorktreesByTicket(deps.store, id)[0]?.path ?? '',
        debug: deps.debug,
      }, parkAt, retry);
    },
    refresh: deps.refresh,
    debug: deps.debug,
  });
  return {
    service,
    hostFor: (ticketId) => ({
      diffFiles: async () => (await diffOf(ticketId))?.files ?? null,
      ensure: (id, opts) => service.ensure(id, opts),
      startPlanning: (title, kickoff) => deps.startPlanning(title, kickoff),
      blockingSeverity: severity,
    }),
  };
}
