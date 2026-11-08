/**
 * Headless runs have no launch intent (@arch:AC-55). This wrapper makes a
 * headless run visible in two ways: the account that started the session is
 * written to the session ledger (so a headless resume reuses it), and the run
 * counts as live under that account while it runs (the delete guard).
 */
import type { AgentAdapter, HeadlessResult, RunHeadlessOpts } from '../adapter.js';
import { accountForLaunch, launchAccountName, recordHeadlessSession, trackHeadlessRun } from './registry.js';
import type { AccountCore } from './types.js';

export function withHeadlessLedger(core: AccountCore, adapter: AgentAdapter): AgentAdapter {
  return new Proxy(adapter, {
    get(target, key, receiver) {
      if (key !== 'runHeadless') return Reflect.get(target, key, receiver);
      return async (opts: RunHeadlessOpts): Promise<HeadlessResult> => {
        const account = launchAccountName(core, accountForLaunch(core, opts.resume, opts.account));
        const end = trackHeadlessRun(core, account);
        try {
          const result = await target.runHeadless(opts);
          if (typeof result.sessionId === 'string') recordHeadlessSession(core, result.sessionId, account);
          return result;
        } finally {
          end();
        }
      };
    },
  });
}
