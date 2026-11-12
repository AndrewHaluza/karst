/**
 * k-tooltip (RD backlog B2): a supplemental label for an icon-only control. One delegated set of listeners on the
 * document, one `role="tooltip"` node. A control opts in with `data-tip="Full label"`; the tooltip shows on pointer hover
 * AND keyboard focus, hides on pointer leave, blur and Escape, and is wired with `aria-describedby` only while shown.
 * The tooltip never carries information found nowhere else: the control keeps its own `aria-label`.
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
    const maxLeft = Math.max(0, (view?.innerWidth ?? 0) - width - GAP_PX);
    el.style.left = `${Math.min(Math.max(GAP_PX, r.left), maxLeft)}px`;
    el.style.top = `${r.bottom + GAP_PX}px`;
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
