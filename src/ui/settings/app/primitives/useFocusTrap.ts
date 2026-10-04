/**
 * Keeps Tab / Shift+Tab inside a dialog surface while `active` (the vanilla
 * `trapFocus` helper, which the React port dropped). Optionally moves focus
 * to `initial` — or the first focusable — when the trap turns on.
 */
import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  initial?: () => HTMLElement | null,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return undefined;
    const focusables = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (initial?.() ?? focusables()[0])?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
    // `initial` is read once when the trap turns on, by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active]);
}
