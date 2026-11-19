/**
 * T1258: binds the host-agnostic model-change ask and switch
 * (`approaches/graph/modelChange.ts`) to the live store and manifest. Both
 * resolve their dependencies on each call, so a manifest reload or a store
 * that opens late is always seen.
 */

import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import type { GraphDb } from '../../store/graph/transitions.js';
import { askModelChange } from '../../approaches/graph/modelChange.js';

export interface ModelChangeSeamsDeps {
  readonly db: () => GraphDb | undefined;
  readonly transaction: <T>(fn: () => T) => T;
  readonly manifest: () => Manifest | undefined;
  readonly graphConfigOf: (approachId: string) => GraphApproachConfig | undefined;
  readonly label: (ticketId: number) => string;
  readonly warn: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  readonly refresh: (ticketId: number) => void;
  readonly debug: (message: string) => void;
  readonly now?: () => string;
}

export interface ModelChangeSeams {
  readonly ask: (filter: { ticketId?: number }) => Promise<number>;
}

export function makeModelChangeSeams(deps: ModelChangeSeamsDeps): ModelChangeSeams {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const scan = () => {
    const db = deps.db();
    const manifest = deps.manifest();
    if (!db || !manifest) return undefined;
    return { db, manifest, graphConfigOf: deps.graphConfigOf, transaction: deps.transaction, now, debug: deps.debug };
  };
  return {
    ask: async (filter) => {
      const base = scan();
      return base ? askModelChange({ ...base, label: deps.label, warn: deps.warn, refresh: deps.refresh }, filter) : 0;
    },
  };
}
