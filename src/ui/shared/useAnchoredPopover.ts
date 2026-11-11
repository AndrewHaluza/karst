import { useLayoutEffect, useRef, type RefObject } from 'react';
import { attachAnchoredPopover } from './anchoredPopover.js';

/** Keeps a `position:fixed` popover on its trigger while `open`; closes it when the trigger leaves the view. */
export function useAnchoredPopover(
  open: boolean,
  popoverRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onTriggerHidden: () => void,
  width?: number,
): void {
  const hidden = useRef(onTriggerHidden);
  hidden.current = onTriggerHidden;
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (!open || !popover || !trigger) return undefined;
    return attachAnchoredPopover({ popover, trigger, width, onTriggerHidden: () => hidden.current() });
  }, [open, popoverRef, triggerRef, width]);
}
