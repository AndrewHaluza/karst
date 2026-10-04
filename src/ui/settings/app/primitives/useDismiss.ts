/**
 * The one Escape / outside-click dismiss for every floating surface in the
 * Settings app (popover, menu, drawer, modal). The vanilla script bound a
 * document listener per surface; the React port dropped them, leaving
 * surfaces that only their own toggle could close.
 *
 * Listeners are attached only while `active`. A mousedown inside any of `refs`
 * (the surface itself and whatever opened it) is not "outside", so the
 * opener's own click toggle keeps working.
 */
import { useEffect, useRef, type RefObject } from 'react';

export interface DismissOptions {
  readonly active: boolean;
  readonly onClose: () => void;
  readonly refs: readonly RefObject<HTMLElement | null>[];
  /** Default true. */
  readonly escape?: boolean;
  /** Default true. */
  readonly outside?: boolean;
}

export function useDismiss({ active, onClose, refs, escape = true, outside = true }: DismissOptions): void {
  // Latest callback/refs without re-binding listeners on every render.
  const latest = useRef({ onClose, refs });
  latest.current = { onClose, refs };

  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!escape || event.key !== 'Escape') return;
      event.preventDefault();
      latest.current.onClose();
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (!outside) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (latest.current.refs.some((ref) => ref.current?.contains(target))) return;
      latest.current.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [active, escape, outside]);
}
