/**
 * Planning outcomes are announced through the action-result live region
 * (`karstSettle`'s success toast). Archive/unarchive succeed when the host acks;
 * `plan-create` acks as soon as its input box opens, so its result is the new row
 * arriving — a cancelled box adds no row and announces nothing.
 *
 * View-side bookkeeping only: nothing here is ticket data and nothing posts.
 */
import type { PlanningRow } from '../state.js';
import { ds } from './runtime.js';

export class PlanNotes {
  private readonly say = new Map<string, string>();
  private watch: Set<number> | null = null;

  /** Remember what to announce when `requestId` settles OK; arm the new-row watch for plan-create. */
  note(type: string, requestId: string, plan: number | undefined, planning: readonly PlanningRow[]): void {
    const row = plan === undefined ? undefined : planning.find((p) => p.sessionId === plan);
    const name = row ? `: ${row.title}` : '';
    if (type === 'plan-archive') this.say.set(requestId, `Planning session archived${name}`);
    if (type === 'plan-unarchive') this.say.set(requestId, `Planning session restored${name}`);
    if (type === 'plan-create') this.watch = new Set(planning.map((p) => p.sessionId));
  }

  /** The host's terminal answer: settle the pending control, announcing the remembered success text. */
  settle(requestId: string, ok: boolean, message: string | undefined): void {
    const said = this.say.get(requestId);
    this.say.delete(requestId);
    ds.settle(requestId, ok, message || (ok === true ? said : undefined));
  }

  /** After a state push: announce a session that appeared since a plan-create was acked. */
  announceNew(planning: readonly PlanningRow[]): void {
    if (!this.watch) return;
    const watch = this.watch;
    const fresh = planning.find((p) => !watch.has(p.sessionId) && p.status !== 'archived');
    if (!fresh) return;
    this.watch = null;
    ds.toast('success', `Planning session started: ${fresh.title}`);
  }
}
