/**
 * The one placement primitive for every `position:fixed` popover and menu in the
 * webviews. It opens below the trigger, flips above when the measured height
 * does not fit below, clamps inside the viewport (content scrolls inside the
 * popover) and keeps an 8 px gutter on both sides (@ui:UI-R56). While attached
 * it re-places on scroll of the page or of ANY ancestor (capture phase) and on
 * resize, and reports when the trigger is fully out of view so the owner can
 * close the popover. It never moves focus.
 */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacementInput {
  readonly trigger: Box;
  readonly popover: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gutter?: number;
  readonly gap?: number;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  /** A height cap in px when neither side fits the popover, else null. */
  readonly maxHeight: number | null;
  readonly side: 'below' | 'above';
  readonly triggerVisible: boolean;
}

export const POPOVER_GUTTER = 8;
export const POPOVER_GAP = 4;

export function computePlacement(input: PlacementInput): Placement {
  const gutter = input.gutter ?? POPOVER_GUTTER;
  const gap = input.gap ?? POPOVER_GAP;
  const { trigger, viewport } = input;
  const width = Math.min(input.popover.width, Math.max(0, viewport.width - 2 * gutter));
  const height = input.popover.height;
  const left = Math.max(gutter, Math.min(trigger.left, viewport.width - width - gutter));

  const belowTop = trigger.top + trigger.height + gap;
  const spaceBelow = viewport.height - gutter - belowTop;
  const spaceAbove = trigger.top - gap - gutter;
  // A trigger with no layout box (display:none, not yet measurable) is not "scrolled out": leave the popover be.
  const unmeasured = trigger.width === 0 && trigger.height === 0;
  const triggerVisible =
    unmeasured ||
    trigger.top + trigger.height > 0 &&
    trigger.top < viewport.height &&
    trigger.left + trigger.width > 0 &&
    trigger.left < viewport.width;

  const placed = placeOnSide({ left, width, height, belowTop, spaceBelow, spaceAbove, triggerTop: trigger.top, gutter, gap, triggerVisible });
  return triggerVisible ? placed : pinToViewport(placed, height, viewport.height, gutter);
}

interface SideInput {
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly belowTop: number;
  readonly spaceBelow: number;
  readonly spaceAbove: number;
  readonly triggerTop: number;
  readonly gutter: number;
  readonly gap: number;
  readonly triggerVisible: boolean;
}

function placeOnSide(i: SideInput): Placement {
  const { left, width, height, belowTop, spaceBelow, spaceAbove, triggerVisible } = i;
  if (height <= spaceBelow) return { left, top: belowTop, width, maxHeight: null, side: 'below', triggerVisible };
  if (height <= spaceAbove) return { left, top: i.triggerTop - i.gap - height, width, maxHeight: null, side: 'above', triggerVisible };
  if (spaceBelow >= spaceAbove) return { left, top: belowTop, width, maxHeight: Math.max(0, spaceBelow), side: 'below', triggerVisible };
  return { left, top: i.gutter, width, maxHeight: Math.max(0, spaceAbove), side: 'above', triggerVisible };
}

/**
 * The trigger is out of view: an owner that keeps the popover open (it holds typed input) must still reach it,
 * so the popover stays on screen instead of following the trigger off the page.
 */
function pinToViewport(p: Placement, height: number, viewportHeight: number, gutter: number): Placement {
  const room = Math.max(0, viewportHeight - 2 * gutter);
  const shown = Math.min(p.maxHeight ?? height, room);
  const top = Math.max(gutter, Math.min(p.top, viewportHeight - gutter - shown));
  return { ...p, top, maxHeight: shown < height ? shown : p.maxHeight };
}

export interface AttachOptions {
  readonly popover: HTMLElement;
  readonly trigger: HTMLElement;
  /** Preferred width in px (shrunk to fit the viewport). Omit to keep the popover's own width. */
  readonly width?: number;
  /**
   * Called once per episode when the trigger is fully out of view; the owner may close the popover or keep it.
   * While the trigger stays out of view the popover is pinned inside the viewport.
   */
  readonly onTriggerHidden: () => void;
}

/** The popover's height without its own cap: a capped box scrolls, so its content height is `scrollHeight`. */
function naturalHeight(popover: HTMLElement): number {
  return Math.max(popover.offsetHeight, popover.scrollHeight + popover.offsetHeight - popover.clientHeight);
}

function place(opts: AttachOptions): boolean {
  const { popover, trigger } = opts;
  const r = trigger.getBoundingClientRect();
  // The cap is never cleared to measure: clearing it resets the popover's own scroll position to the top.
  const p = computePlacement({
    trigger: { left: r.left, top: r.top, width: r.width, height: r.height },
    popover: { width: opts.width ?? (popover.offsetWidth || 176), height: naturalHeight(popover) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  popover.style.left = `${p.left}px`;
  popover.style.top = `${p.top}px`;
  if (opts.width !== undefined) popover.style.width = `${p.width}px`;
  const cap = p.maxHeight === null ? '' : `${p.maxHeight}px`;
  if (popover.style.maxHeight !== cap) popover.style.maxHeight = cap;
  const overflow = p.maxHeight === null ? '' : 'auto';
  if (popover.style.overflowY !== overflow) popover.style.overflowY = overflow;
  return p.triggerVisible;
}

/** Places the popover now and keeps it on its trigger until the returned detach runs. */
export function attachAnchoredPopover(opts: AttachOptions): () => void {
  let frame: number | null = null;
  let hidden = false;
  const sync = (): void => {
    const visible = place(opts);
    if (visible) hidden = false;
    else if (!hidden) {
      hidden = true;
      opts.onTriggerHidden();
    }
  };
  const update = (): void => {
    frame = null;
    sync();
  };
  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(update);
  };
  sync();
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  return () => {
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
