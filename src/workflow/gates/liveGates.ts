import { gateWaitDetail, type GateLiveState, type GateWait } from '../../model/inside/gateWait.js';
import type { LiveOperationView } from '../../model/inside/progress.js';

/** What a gate runner reports into the live state of one ticket and stage. */
export interface GateLiveSink {
  start(gate: string): void;
  wait(gate: string, wait: GateWait): void;
  end(gate: string): void;
}

/**
 * The live state of the gates in flight, per ticket and stage: host memory only, never recorded. A gate that waits
 * for a slot reads `wait`; the slot taken reads `run` with the instant it was taken, so the row timer never counts
 * the wait. The Inside gates row reads `snapshot` (@arch:GATE-CONCURRENCY).
 */
export class LiveGateRegistry {
  private readonly states = new Map<string, Map<string, GateLiveState>>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  private key(ticketId: number, stage: string): string {
    return `${ticketId}:${stage}`;
  }

  /** The gate runs. A gate that waited keeps the instant its slot was taken; a gate that already runs stays as it is. */
  start(ticketId: number, stage: string, gate: string): void {
    const map = this.states.get(this.key(ticketId, stage)) ?? new Map<string, GateLiveState>();
    const prev = map.get(gate);
    if (prev?.kind === 'run') return;
    map.set(gate, prev?.kind === 'wait' ? { kind: 'run', since: this.now() } : { kind: 'run' });
    this.states.set(this.key(ticketId, stage), map);
  }

  wait(ticketId: number, stage: string, gate: string, wait: GateWait): void {
    const map = this.states.get(this.key(ticketId, stage)) ?? new Map<string, GateLiveState>();
    map.set(gate, { kind: 'wait', wait });
    this.states.set(this.key(ticketId, stage), map);
  }

  end(ticketId: number, stage: string, gate: string): void {
    this.states.get(this.key(ticketId, stage))?.delete(gate);
  }

  clear(ticketId: number, stage?: string): void {
    if (stage !== undefined) this.states.delete(this.key(ticketId, stage));
    else for (const k of [...this.states.keys()]) if (k.startsWith(`${ticketId}:`)) this.states.delete(k);
  }

  /** A sink bound to one ticket and stage; `onChange` runs after each change so the host can repaint. */
  sinkFor(ticketId: number, stage: string, onChange?: () => void): GateLiveSink {
    return {
      start: (gate) => { this.start(ticketId, stage, gate); onChange?.(); },
      wait: (gate, wait) => { this.wait(ticketId, stage, gate, wait); onChange?.(); },
      end: (gate) => { this.end(ticketId, stage, gate); onChange?.(); },
    };
  }

  /** The live gates of one stage by name; undefined when none is in flight. */
  snapshot(ticketId: number, stage: string): Readonly<Record<string, GateLiveState>> | undefined {
    const map = this.states.get(this.key(ticketId, stage));
    return map && map.size > 0 ? Object.fromEntries(map) : undefined;
  }
}

/** The header overlay of a gate that waits for a slot (bounded text; the row holds the slot text). */
export function gateWaitLive(gate: string, wait: GateWait): LiveOperationView {
  return { status: 'wait', label: gate.slice(0, 200), detail: gateWaitDetail(wait).slice(0, 200) };
}
