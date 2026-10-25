/**
 * Places a `position:fixed` popover just below its trigger, clamped to the viewport.
 * The one sanctioned imperative-style site of the dashboard app: a fixed surface is
 * positioned from the trigger's measured rect, which CSS cannot express (the panel's
 * `overflow:hidden` is why it is fixed to the viewport at all).
 */
export function placeBelow(popover: HTMLElement, trigger: HTMLElement, width: number): void {
  const rect = trigger.getBoundingClientRect();
  let left = rect.left;
  if (left + width > window.innerWidth) left = window.innerWidth - width - 8;
  if (left < 8) left = 8;
  popover.style.left = `${left}px`;
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.width = `${width}px`;
}
