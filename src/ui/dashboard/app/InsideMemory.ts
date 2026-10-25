/**
 * The Inside block's local view state: what the user opened, collapsed or switched. React state that lives above
 * the block, so it survives every push and every stage switch. It is never in `DashboardState`, never round-trips
 * through the host and (as in the vanilla page) is not persisted; only the user's own toggle mutates it.
 *
 *  - process disclosures, keyed `stage:id`: `open` holds the ones opened, `closed` the ones explicitly COLLAPSED. A key
 *    in neither was never touched, so the default applies (the session, a running process).
 *  - the graph's ledger / DAG view, per ticket, so one ticket's choice never leaks into another.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

export class InsideMemory {
  private readonly open = new Set<string>();
  private readonly closed = new Set<string>();
  private readonly dag = new Map<number, boolean>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** The user's own verdict on a disclosure: true/false once touched, null when it was never touched. */
  explicit(key: string): boolean | null {
    if (this.open.has(key)) return true;
    if (this.closed.has(key)) return false;
    return null;
  }

  /** The row's native `toggle` reported its new state. No render: the DOM already shows it. */
  toggled(key: string, isOpen: boolean): void {
    if (isOpen) {
      this.open.add(key);
      this.closed.delete(key);
    } else {
      this.open.delete(key);
      this.closed.add(key);
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  dagShown(ticketId: number): boolean {
    return this.dag.get(ticketId) === true;
  }

  toggleDag(ticketId: number): void {
    this.dag.set(ticketId, !this.dagShown(ticketId));
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface InsideScope {
  readonly memory: InsideMemory;
  /** The stage whose block is on screen. */
  readonly stageKey: string;
  readonly ticketId: number;
}

export const InsideScopeContext = createContext<InsideScope | null>(null);

export function useInsideScope(): InsideScope {
  const scope = useContext(InsideScopeContext);
  if (!scope) throw new Error('useInsideScope must be used within the Inside block');
  return scope;
}

/** Whether the graph shows its DAG strip: re-renders only the toggle and the graph body. */
export function useDagShown(): boolean {
  const { memory, ticketId } = useInsideScope();
  useSyncExternalStore(memory.subscribe, memory.getVersion);
  return memory.dagShown(ticketId);
}
