/**
 * The header's hover/focus card primitive (T1400; the Models card reuses it).
 *
 * A card opens on a 300 ms pointer hover or AT ONCE on keyboard focus (`@ui:UI-R22`), survives the 200 ms it
 * takes the pointer to cross from the trigger into the card, closes on Escape (returning focus to the trigger
 * when the card held it) or a click outside, and never traps focus: Tab walks from the trigger into the card
 * and on out. The card is positioned by the shared `useAnchoredPopover`, so it also closes when its trigger
 * leaves the view (a resize into the tight tier hides the trigger).
 *
 * Only ONE header surface is open at a time. Surfaces coordinate through a `document` event rather than a
 * module-level registry: opening the ⋯ menu, another hover card or a PR popover closes every other surface,
 * and a test that mounts a component fresh starts with no shared state to leak into the next one.
 */
import { useCallback, useEffect, useRef, useState, type FocusEvent, type RefObject } from 'react';
import { useAnchoredPopover } from '../../shared/useAnchoredPopover.js';

/** How long the pointer must rest on the trigger before the card opens. */
export const HOVER_OPEN_DELAY_MS = 300;
/** The grace the pointer gets to cross from the trigger into the card. */
export const HOVER_CLOSE_GRACE_MS = 200;

const SURFACE_EVENT = 'karst-surface-open';

/** Claims the header for `surfaceId`: every other subscribed surface closes. */
export function announceSurfaceOpen(surfaceId: string): void {
  document.dispatchEvent(new CustomEvent<{ id: string }>(SURFACE_EVENT, { detail: { id: surfaceId } }));
}

/** Runs `onClose` when a DIFFERENT surface opens; the surface that announced is left alone. */
export function useSurfaceClose(surfaceId: string, onClose: () => void): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const id = (e as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id === 'string' && id !== surfaceId) latest.current();
    };
    document.addEventListener(SURFACE_EVENT, onOpen);
    return () => document.removeEventListener(SURFACE_EVENT, onOpen);
  }, [surfaceId]);
}

export interface HoverCardOptions {
  /** The surface id this card claims while open (`planning-card`, `models-card`, ...). */
  readonly id: string;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly cardRef: RefObject<HTMLElement | null>;
  /** Preferred card width in px; the popover clamps it inside the viewport (`@ui:UI-R56`). */
  readonly width?: number;
  /** False disables opening (and closes an open card). */
  readonly enabled?: boolean;
}

export interface HoverCardHandlers {
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
}

export interface HoverCardTriggerHandlers extends HoverCardHandlers {
  readonly onFocus: () => void;
  /** A mouse press focuses the trigger too: that focus must not open the card, or the click that follows closes it. */
  readonly onMouseDown: () => void;
  readonly onBlur: (e: FocusEvent<HTMLElement>) => void;
}

export interface HoverCardCardHandlers extends HoverCardHandlers {
  readonly onBlur: (e: FocusEvent<HTMLElement>) => void;
}

export interface HoverCardView {
  readonly open: boolean;
  readonly close: () => void;
  /** Opens the card at once (the click-toggle path; hover/focus go through `triggerProps`). */
  readonly show: () => void;
  readonly triggerProps: HoverCardTriggerHandlers;
  readonly cardProps: HoverCardCardHandlers;
}

type Timer = ReturnType<typeof setTimeout>;

export function useHoverCard({ id, triggerRef, cardRef, width, enabled = true }: HoverCardOptions): HoverCardView {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<Timer | null>(null);
  const closeTimer = useRef<Timer | null>(null);
  /** Set right before a programmatic focus return, so Escape does not immediately re-open the card. */
  const suppressFocus = useRef(false);
  /** Set by a mouse press on the trigger: the focus it causes is left to the click (toggle), not opened at once. */
  const pressFocus = useRef(false);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const clearTimers = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearOpenTimer, clearCloseTimer]);

  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  const show = useCallback(() => {
    clearTimers();
    setOpen(true);
    // Claim the header: the ⋯ menu and any other hover card close (one surface at a time).
    announceSurfaceOpen(id);
  }, [clearTimers, id]);

  const scheduleOpen = useCallback(() => {
    // Coming back onto the trigger during the leave grace cancels the pending close, even while still open.
    clearCloseTimer();
    if (!enabled || open) return;
    if (openTimer.current !== null) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      show();
    }, HOVER_OPEN_DELAY_MS);
  }, [enabled, open, clearCloseTimer, show]);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    if (!open || closeTimer.current !== null) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      // A keyboard user who Tabbed into the card keeps it: stray pointer movement must not dismiss their focus.
      if (cardRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, HOVER_CLOSE_GRACE_MS);
  }, [open, clearOpenTimer, cardRef]);

  const cancelClose = useCallback(() => clearCloseTimer(), [clearCloseTimer]);

  // Keyboard focus opens at once; the guard swallows the focus the Escape handler itself returns.
  const onFocus = useCallback(() => {
    if (suppressFocus.current) {
      suppressFocus.current = false;
      return;
    }
    if (pressFocus.current) {
      pressFocus.current = false;
      return;
    }
    if (!enabled) return;
    show();
  }, [enabled, show]);

  // The flag lives only for the focus the press itself causes; a browser that does not focus on click clears it next tick.
  const onMouseDown = useCallback(() => {
    pressFocus.current = true;
    setTimeout(() => {
      pressFocus.current = false;
    }, 0);
  }, []);

  const onBlur = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null;
      // Tab into the card (no focus trap) and between its controls keeps it open.
      clearTimers();
      if (next && (triggerRef.current?.contains(next) || cardRef.current?.contains(next))) return;
      setOpen(false);
    },
    [clearTimers, triggerRef, cardRef],
  );

  // While open: Escape dismisses (returning focus to the trigger when the card held it), a click outside closes.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      // An overlay above (a drawer, a picker) claims Escape first: that press is spent.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const focusWasInside = cardRef.current?.contains(document.activeElement) === true;
      close();
      e.preventDefault();
      e.stopPropagation();
      if (focusWasInside) {
        suppressFocus.current = true;
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || cardRef.current?.contains(target))) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open, close, triggerRef, cardRef]);

  // A disabled card closes, and an unmount never leaves a timer behind.
  useEffect(() => {
    if (enabled) return;
    clearTimers();
    setOpen(false);
  }, [enabled, clearTimers]);
  useEffect(() => () => clearTimers(), [clearTimers]);

  // Opening any other surface closes this card at once (and forgets its timers).
  useSurfaceClose(id, close);

  useAnchoredPopover(open, cardRef, triggerRef, close, width);

  return {
    open,
    close,
    show,
    triggerProps: { onPointerEnter: scheduleOpen, onPointerLeave: scheduleClose, onMouseEnter: scheduleOpen, onMouseLeave: scheduleClose, onFocus, onBlur, onMouseDown },
    cardProps: { onPointerEnter: cancelClose, onPointerLeave: scheduleClose, onMouseEnter: cancelClose, onMouseLeave: scheduleClose, onBlur },
  };
}
