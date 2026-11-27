/**
 * k-tooltip (RD backlog B2, @ui:11.18): a supplemental label for an icon-only control. One delegated set of
 * listeners on the document, one `role="tooltip"` node. A control opts in with `data-tip="Full label"`; the
 * tooltip shows on pointer hover AND keyboard focus, hides on pointer leave, blur and Escape, and is wired
 * with `aria-describedby` only while shown. The tooltip never carries information found nowhere else: the
 * control keeps its own `aria-label`.
 *
 * Shared by every webview that has a React entry (the dashboard mounts it in `main.tsx`, the sidebar does the
 * same): a `data-tip` chip such as `.k-pri` gets the hint without a native `title`.
 */
export const TOOLTIP_ID = 'k-tooltip';
const TIP_ATTR = 'data-tip';
const GAP_PX = 6;

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>(`[${TIP_ATTR}]`) : null;
}

/** Installs the delegate on `doc` and returns the function that removes it, with its node. */
export function installTooltip(doc: Document): () => void {
  let node: HTMLElement | null = null;
  let current: HTMLElement | null = null;

  const ensureNode = (): HTMLElement => {
    if (node) return node;
    const el = doc.createElement('div');
    el.id = TOOLTIP_ID;
    el.className = 'k-tooltip';
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    doc.body.appendChild(el);
    node = el;
    return el;
  };

  const hide = (): void => {
    current?.removeAttribute('aria-describedby');
    current = null;
    if (node) node.hidden = true;
  };

  const place = (el: HTMLElement, target: HTMLElement): void => {
    const view = doc.defaultView;
    const r = target.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const viewportW = view?.innerWidth ?? 0;
    const viewportH = view?.innerHeight ?? 0;
    const maxLeft = Math.max(0, viewportW - width - GAP_PX);
    el.style.left = `${Math.min(Math.max(GAP_PX, r.left), maxLeft)}px`;
    // Below the control by default; flip above when that would run past the viewport (a row at the bottom edge of the
    // sidebar pane), and clamp when neither side fits so the hint stays readable instead of clipping off-screen.
    const below = r.bottom + GAP_PX;
    const above = r.top - GAP_PX - height;
    const top =
      below + height <= viewportH - GAP_PX
        ? below
        : above >= GAP_PX
          ? above
          : Math.max(GAP_PX, Math.min(below, viewportH - height - GAP_PX));
    el.style.top = `${top}px`;
  };

  const show = (target: HTMLElement): void => {
    const text = target.getAttribute(TIP_ATTR);
    if (!text) return;
    if (current && current !== target) current.removeAttribute('aria-describedby');
    const el = ensureNode();
    el.textContent = text;
    el.hidden = false;
    target.setAttribute('aria-describedby', TOOLTIP_ID);
    current = target;
    place(el, target);
  };

  const onEnter = (e: Event): void => {
    const t = tipTarget(e.target);
    if (t) show(t);
  };
  const onLeave = (e: Event): void => {
    if (tipTarget(e.target) === current) hide();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && current) hide();
  };

  doc.addEventListener('mouseover', onEnter);
  doc.addEventListener('focusin', onEnter);
  doc.addEventListener('mouseout', onLeave);
  doc.addEventListener('focusout', onLeave);
  doc.addEventListener('keydown', onKey);

  return () => {
    doc.removeEventListener('mouseover', onEnter);
    doc.removeEventListener('focusin', onEnter);
    doc.removeEventListener('mouseout', onLeave);
    doc.removeEventListener('focusout', onLeave);
    doc.removeEventListener('keydown', onKey);
    hide();
    node?.remove();
    node = null;
  };
}
