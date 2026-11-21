/** Which slot a gate waits for: the per-gate host lease, the integration port band, or the sandbox project slot. */
export type GateWaitKind = 'gate' | 'port' | 'sandbox';

/** One typed wait, reported once when a lease finds no free slot (@arch:GATE-CONCURRENCY). */
export interface GateWait {
  readonly kind: GateWaitKind;
  /** Slots in use now. Absent when the source does not count them (the port lease). */
  readonly held?: number;
  /** Slots the pool has. Absent when unknown. */
  readonly limit?: number;
}

/** The live state of one gate: waiting for a slot, or running (`since` = when the slot was taken, so the timer never counts the wait). */
export type GateLiveState = { readonly kind: 'wait'; readonly wait: GateWait } | { readonly kind: 'run'; readonly since?: string };

/** The row detail of a gate that waits for a slot. */
export function gateWaitDetail(w: GateWait): string {
  if (w.kind === 'port') return 'waiting for a port slot';
  if (w.kind === 'sandbox') return `waiting for a gate slot (${w.held ?? 0} running)`;
  return `waiting for a free slot (${w.held ?? 0} of ${w.limit ?? 0} in use by other tickets)`;
}
