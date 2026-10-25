/**
 * Slice selection for the 1 Hz full-snapshot pushes (migration plan A4).
 *
 * The host re-sends the whole `DashboardState` every second while work runs, so a panel
 * subscribes to the slice it renders, not to the snapshot. `useSlice` hands back the
 * PREVIOUS slice object when the new one is structurally equal, which is what lets
 * React skip the panel's render for a push that changed nothing it shows.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useStore } from './DashboardAppContext.js';

/** Structural equality for JSON-shaped data (the host snapshot is plain data). */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]));
}

/** `select` must be a stable (module-level) function. */
export function useSlice<T>(select: (snapshot: DashboardSnapshot) => T): T {
  const store = useStore();
  const last = useRef<{ value: T } | null>(null);
  const getSnapshot = useCallback((): T => {
    const next = select(store.getSnapshot());
    if (last.current && structurallyEqual(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  }, [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}
