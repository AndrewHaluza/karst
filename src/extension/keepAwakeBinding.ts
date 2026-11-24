import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { Store } from '../store/db.js';
import type { Drain } from '../runtime/drain.js';
import { liveDeliverTickets } from './ops/autoDeliverOps.js';
import {
  KEEP_AWAKE_INTERVAL_MS,
  keepAwakeLiveKeys,
  makeKeepAwake,
} from './ops/keepAwake.js';

/**
 * The vscode binding of the keep-awake lock (@arch:KEEPAWAKE): one `caffeinate`
 * child per window while a run of this window is live. The `karst.keepAwake`
 * setting is read on every tick, so a change applies within
 * `KEEP_AWAKE_INTERVAL_MS` without a reload. The live set is the drain's own
 * (`listLiveRuns` + the tracked runs), so the lock and the drain never disagree.
 */
export function registerKeepAwake(
  store: Store,
  drain: Drain,
  projectId: () => number | undefined,
  debug: (message: string) => void,
): vscode.Disposable {
  const keepAwake = makeKeepAwake({
    platform: process.platform,
    hostPid: process.pid,
    mode: () => vscode.workspace.getConfiguration('karst').get<string>('keepAwake'),
    liveKeys: () =>
      keepAwakeLiveKeys(store, process.pid, projectId(), drain.inFlight(), liveDeliverTickets(), Date.now()),
    now: () => Date.now(),
    spawn: (command, args, options) => spawn(command, args, options),
    debug,
  });
  const tick = (): void => {
    // A tick during deactivation can read a closed store: log it, never let the
    // timer throw into the extension host.
    try {
      keepAwake.tick();
    } catch (error) {
      debug(`keep awake: tick failed: ${String(error)}`);
    }
  };
  const timer = setInterval(tick, KEEP_AWAKE_INTERVAL_MS);
  tick();
  return new vscode.Disposable(() => {
    clearInterval(timer);
    keepAwake.dispose();
  });
}
