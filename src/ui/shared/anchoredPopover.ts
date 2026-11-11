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

  if (height <= spaceBelow) return { left, top: belowTop, width, maxHeight: null, side: 'below', triggerVisible };
  if (height <= spaceAbove) return { left, top: trigger.top - gap - height, width, maxHeight: null, side: 'above', triggerVisible };
  if (spaceBelow >= spaceAbove) return { left, top: belowTop, width, maxHeight: Math.max(0, spaceBelow), side: 'below', triggerVisible };
  return { left, top: gutter, width, maxHeight: Math.max(0, spaceAbove), side: 'above', triggerVisible };
}

export interface AttachOptions {
  readonly popover: HTMLElement;
  readonly trigger: HTMLElement;
  /** Preferred width in px (shrunk to fit the viewport). Omit to keep the popover's own width. */
  readonly width?: number;
  /** Called once when the trigger is fully out of view. */
  readonly onTriggerHidden: () => void;
}

function place(opts: AttachOptions): boolean {
  const { popover, trigger } = opts;
  const r = trigger.getBoundingClientRect();
  // Release a previous cap so the natural height is measured.
  popover.style.maxHeight = '';
  popover.style.overflowY = '';
  const p = computePlacement({
    trigger: { left: r.left, top: r.top, width: r.width, height: r.height },
    popover: { width: opts.width ?? (popover.offsetWidth || 176), height: popover.offsetHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  popover.style.left = `${p.left}px`;
  popover.style.top = `${p.top}px`;
  if (opts.width !== undefined) popover.style.width = `${p.width}px`;
  if (p.maxHeight !== null) {
    popover.style.maxHeight = `${p.maxHeight}px`;
    popover.style.overflowY = 'auto';
  }
  return p.triggerVisible;
}

/** Places the popover now and keeps it on its trigger until the returned detach runs. */
export function attachAnchoredPopover(opts: AttachOptions): () => void {
  let frame: number | null = null;
  let hidden = false;
  const update = (): void => {
    frame = null;
    if (!place(opts) && !hidden) {
      hidden = true;
      opts.onTriggerHidden();
    }
  };
  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(update);
  };
  if (!place(opts)) {
    hidden = true;
    opts.onTriggerHidden();
  }
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  return () => {
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
