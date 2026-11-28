/**
 * A graph node's details card and the one hook its two triggers share.
 *
 * The host words the card (title + ordered facts, UI-R31); this file only places it and styles it. The node list's
 * row and the DAG strip's chip are the same surface: pointer hover (after a short delay) or keyboard focus opens
 * ONE card at a time, and pointer leave, blur or Escape closes it (UI-R22). Nothing is posted and nothing is pinned.
 *
 * The open state is local to the trigger and coordinated through the header's surface event, so opening a card
 * closes any other open surface and a fresh mount starts with no shared module state.
 */
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type RefObject } from 'react';
import type { GraphNodeCard as GraphNodeCardView } from '../../../model/inside/types.js';
import { useAnchoredPopover } from '../../shared/useAnchoredPopover.js';
import { announceSurfaceOpen, useSurfaceClose } from './useHoverCard.js';

/** How long the pointer must rest on a node row or chip before its card opens; focus opens it at once. */
export const NODE_CARD_OPEN_DELAY_MS = 300;

/** The card's preferred width in px; the shared placement clamps it inside the viewport (UI-R56). */
const CARD_WIDTH = 340;

export interface NodeCardTriggerProps {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly tabIndex?: number;
  readonly 'data-node-card'?: string;
  readonly 'aria-describedby'?: string;
  readonly onPointerEnter?: () => void;
  readonly onPointerLeave?: () => void;
  readonly onMouseEnter?: () => void;
  readonly onMouseLeave?: () => void;
  readonly onFocus?: (e: FocusEvent<HTMLDivElement>) => void;
  readonly onBlur?: (e: FocusEvent<HTMLDivElement>) => void;
}

export interface NodeCardState {
  /** The card element's id, used as the trigger's `aria-describedby` while it is open. */
  readonly cardId: string;
  readonly open: boolean;
  readonly triggerRef: RefObject<HTMLDivElement | null>;
  readonly cardRef: RefObject<HTMLDivElement | null>;
  readonly close: () => void;
  /** Spread onto the row or chip. A trigger without a card gets no tab stop and no hover handlers. */
  readonly triggerProps: NodeCardTriggerProps;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * The shared open/close state of one node row's or chip's card. A trigger with no card stays inert (no tab stop,
 * no hover), which is what keeps planner and deferred rows exactly as they were.
 */
export function useNodeCard(card: GraphNodeCardView | undefined): NodeCardState {
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<Timer | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const show = useCallback(() => {
    clearTimer();
    setOpen(true);
    // One surface at a time: another row's card (and any header hover card) closes.
    announceSurfaceOpen(cardId);
  }, [clearTimer, cardId]);

  const scheduleOpen = useCallback(() => {
    if (!card || open || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
      announceSurfaceOpen(cardId);
    }, NODE_CARD_OPEN_DELAY_MS);
  }, [card, open, cardId]);

  useSurfaceClose(cardId, close);
  useEffect(() => () => clearTimer(), [clearTimer]);
  // A card the host stops sending cannot stay on screen behind an inert trigger.
  useEffect(() => {
    if (!card) close();
  }, [card, close]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      // An overlay above (a drawer, a picker) claims Escape first: that press is spent.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      close();
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!card) {
    return { cardId, open: false, triggerRef, cardRef, close, triggerProps: { ref: triggerRef } };
  }

  return {
    cardId,
    open,
    triggerRef,
    cardRef,
    close,
    triggerProps: {
      ref: triggerRef,
      tabIndex: 0,
      'data-node-card': '',
      // Only while the card is on screen: a described-by that points at nothing is a dead reference.
      ...(open ? { 'aria-describedby': cardId } : {}),
      onPointerEnter: scheduleOpen,
      onPointerLeave: close,
      onMouseEnter: scheduleOpen,
      onMouseLeave: close,
      onFocus: (e) => {
        // Focus moving into the row's own action button is not a focus on the trigger.
        if (e.target === e.currentTarget) show();
      },
      onBlur: (e) => {
        const next = e.relatedTarget as Node | null;
        // Focus that lands in the card itself keeps it open; every other move closes it.
        if (next && cardRef.current?.contains(next)) return;
        close();
      },
    },
  };
}

export interface GraphNodeCardProps {
  readonly card: GraphNodeCardView;
  readonly id: string;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

/**
 * The card surface: the host's title (when it sent one) over a `<dl>` of the facts in exactly the host's order.
 * Fixed to the viewport and placed by the shared anchored popover, so the list's own overflow cannot clip it.
 */
export function GraphNodeCard({ card, id, triggerRef, onClose }: GraphNodeCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  useAnchoredPopover(true, ref, triggerRef, onClose, CARD_WIDTH);
  return (
    <div ref={ref} id={id} role="tooltip" className="graph-card">
      {card.title ? <div className="graph-card-title">{card.title}</div> : null}
      {card.facts.length > 0 ? (
        <dl className="graph-card-facts">
          {card.facts.map((fact, index) => (
            <div className="graph-card-fact" key={`${fact.label}:${index}`}>
              <dt className="graph-card-k">{fact.label}</dt>
              <dd className="graph-card-v">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
