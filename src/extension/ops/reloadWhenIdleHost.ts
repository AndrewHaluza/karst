import type { Store } from '../../store/db.js';
import type { Drain } from '../../runtime/drain.js';
import { setHeadlessDrain } from '../../agent/headlessSpawn.js';
import { liveDeliverTickets, setDeliverDrain } from './autoDeliverOps.js';
import { formatId } from '../../model/entityId.js';
import { RELOAD_WHEN_IDLE_TITLE, listLiveRuns, reloadWhenIdle, type LiveRun } from './reloadWhenIdle.js';
import { bindReloadDrain, drainSignature, notifyDrainChange, type DrainSnapshot } from './reloadDrainView.js';

/**
 * The vscode-free logic behind "Karst: Reload window when idle" (@arch:DRAIN-01).
 * `reloadWhenIdleBinding.ts` binds the `ReloadWhenIdleHost` seam to vscode, so
 * the command flow runs under vitest with a fake host.
 */
export interface ReloadWhenIdleHost {
  /** Shows a one-line information message. */
  inform(message: string): void;
  /**
   * Shows a cancellable progress notification with `title`. `run` gets a
   * `report` for the notification text and `onCancel` to register the cancel hook.
   */
  withProgress(
    title: string,
    run: (report: (message: string) => void, onCancel: (listener: () => void) => void) => Promise<void>,
  ): Promise<void>;
  reloadWindow(): Promise<void>;
}

export const RELOAD_ALREADY_WAITING_MESSAGE = 'Karst: a reload is already waiting for live runs.';

/**
 * The progress text for a live-run count. With `runs` that all name a ticket, the text names them
 * (`Waiting for T1183 deliver, T1188 ship`); otherwise it keeps the count.
 */
export function idleProgressMessage(live: number, runs: readonly LiveRun[] = []): string {
  if (live === 0) return 'Reloading…';
  if (runs.length === live && runs.every((r) => r.ticketId !== null)) {
    return `Waiting for ${runs.map((r) => `${formatId('ticket', r.ticketId as number)} ${r.kind}`).join(', ')} — no new runs start`;
  }
  return `Waiting for ${live} live run${live === 1 ? '' : 's'} — no new runs start`;
}

/** A sleep that ends at once when `signal` aborts, and leaves no timer behind. */
export function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
}

/** Wires the drain into the auto-deliver and headless start guards. */
export function installReloadDrain(drain: Drain): void {
  setDeliverDrain(() => drain.isDraining(), (fn) => drain.track(fn)); // no auto-deliver or skipped-gate re-run starts while draining
  setHeadlessDrain(drain); // every headless start is counted live and refused while draining
}

/** The handler of the reload-when-idle command. */
export function makeReloadWhenIdleHandler(
  store: Store,
  drain: Drain,
  log: (message: string) => void,
  redrive: (ticketId: number) => void,
  host: ReloadWhenIdleHost,
  hostPid: number = process.pid,
): () => Promise<void> {
  return async () => {
    if (drain.isDraining()) {
      host.inform(RELOAD_ALREADY_WAITING_MESSAGE);
      return;
    }
    await host.withProgress(RELOAD_WHEN_IDLE_TITLE, async (report, onCancel) => {
      const ac = new AbortController();
      onCancel(() => ac.abort());
      let runs: LiveRun[] = [];
      const snapshot = (): DrainSnapshot => ({ draining: drain.isDraining(), live: runs, held: drain.heldIds() });
      let lastSignature = '';
      const pushIfChanged = (): void => {
        const signature = drainSignature(snapshot());
        if (signature === lastSignature) return;
        lastSignature = signature;
        notifyDrainChange();
      };
      const sleep = abortableSleep(ac.signal);
      const unbind = bindReloadDrain(snapshot, () => ac.abort());
      try {
        await reloadWhenIdle({
          drain,
          signal: ac.signal,
          log,
          onCancelled: (held) => held.forEach((id) => redrive(id)),
          countLive: () => {
            runs = listLiveRuns(store, hostPid, drain.inFlight(), ...liveDeliverTickets());
            return runs.length;
          },
          onCount: (n) => {
            report(idleProgressMessage(n, runs));
            pushIfChanged();
          },
          reload: () => host.reloadWindow(),
          // A held ticket changes the snapshot between two counts, so each poll checks it.
          sleep: (ms) => {
            pushIfChanged();
            return sleep(ms);
          },
        });
      } finally {
        unbind();
      }
    });
  };
}
