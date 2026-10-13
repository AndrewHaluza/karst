import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import type { Manifest, AgentProvider } from '../manifest/types.js';
import type { ModelCatalog } from '../agent/modelCatalog.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { Notify } from './ops/notify.js';
import { makeUsageLimitParkActions, type UsageLimitParkActions } from './ops/usageLimitParkOps.js';

export type { UsageLimitParkActions };

export interface UsageLimitParkBindingDeps {
  store: Store;
  notify: Notify;
  catalog: () => ModelCatalog;
  manifest: () => Manifest | undefined;
  redrive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
  artifactDirFor: (ticketId: number) => string;
  cwd: () => string;
  debug?: (msg: string) => void;
}

export function createUsageLimitParkBinding(deps: UsageLimitParkBindingDeps) {
  return {
    forTicket: (ticketId: number) =>
      makeUsageLimitParkActions({
        store: deps.store,
        ticketId,
        notify: deps.notify,
        catalog: deps.catalog,
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        pickCore: async (items) => {
          const picked = await vscode.window.showQuickPick(items, { title: 'Pick agent core' });
          return picked;
        },
        pickModel: async (items) => {
          const picked = await vscode.window.showQuickPick(items, { title: 'Pick model' });
          return picked;
        },
        adapterFor: deps.adapterFor,
        artifactDir: () => deps.artifactDirFor(ticketId),
        cwd: deps.cwd,
        debug: deps.debug,
      }),
  };
}
