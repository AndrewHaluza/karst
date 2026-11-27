/**
 * The sticky ticket header's DOM plumbing (T1396): a 1 px sentinel before `.dhead` that an
 * `IntersectionObserver` watches for `data-stuck="true"` (the shadow), and a `ResizeObserver` on the chrome
 * rows that writes `--k-headbar-h` (scroll padding) and `--k-drill-chrome` (the drill views' `100vh -`
 * subtraction) on the document element.
 *
 * Two deliberate limits keep this loop-free and host-agnostic:
 * - it observes only the four chrome roots, never a drill view or the document element, so a write cannot
 *   feed back into an observation of its own size;
 * - it writes a custom property only when the rounded integer changed, so a fractional sub-pixel resize
 *   settles after one write instead of ticking the observer forever.
 * The element styles live here (not in a component) because CSS cannot express them; `architecture.test.ts`
 * allows this file by name.
 */

const SENTINEL_CLASS = 'dheadSentinel';
const HEAD_HEIGHT_PROP = '--k-headbar-h';
const DRILL_CHROME_PROP = '--k-drill-chrome';

const px = (value: string | number): number => Number.parseFloat(String(value)) || 0;

/** Border-box height plus its vertical margins; 0 while the element draws nothing (hidden or not laid out). */
function outerHeight(el: Element | null, view: Window | null): number {
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (rect.height === 0) return 0;
  const cs = view?.getComputedStyle(el);
  return rect.height + (cs ? px(cs.marginTop) + px(cs.marginBottom) : 0);
}

/**
 * The space the runtime strip occupies. `#runtimeRoot` has no margin, padding or border of its own: its child
 * `.rs-wrap` owns the bottom margin, and in normal flow that margin collapses out of the root, so the root's own
 * box does not include the gap. Measuring the child too keeps the gap in `--k-drill-chrome`; miss it and every
 * drill view (sized `100vh - chrome`) overflows the page by that gap and opens a second scrollbar.
 */
function runtimeSpace(doc: Document, view: Window | null): number {
  const root = doc.getElementById('runtimeRoot');
  return Math.max(outerHeight(root, view), outerHeight(root?.firstElementChild ?? null, view));
}

/**
 * Mounts the header observers; returns the cleanup. A document without `.dhead` (another view, or a test
 * that mounts a fragment) gets a no-op so every caller can mount it unconditionally.
 */
export function attachStickyHeader(doc: Document): () => void {
  const dhead = doc.getElementsByClassName('dhead')[0] as HTMLElement | undefined;
  if (!dhead) return () => {};
  const view = doc.defaultView;

  const sentinel = doc.createElement('div');
  sentinel.className = SENTINEL_CLASS;
  sentinel.setAttribute('aria-hidden', 'true');
  dhead.parentElement?.insertBefore(sentinel, dhead);

  const root = doc.documentElement;
  let lastHeadH: number | null = null;
  let lastDrillChrome: number | null = null;

  const measure = (): void => {
    const headH = Math.ceil(dhead.getBoundingClientRect().height);
    if (headH !== lastHeadH) {
      lastHeadH = headH;
      root.style.setProperty(HEAD_HEIGHT_PROP, `${headH}px`);
    }
    const bodyCs = doc.body ? view?.getComputedStyle(doc.body) : undefined;
    const bodyPadY = bodyCs ? px(bodyCs.paddingTop) + px(bodyCs.paddingBottom) : 0;
    const chrome = Math.ceil(
      bodyPadY +
        outerHeight(dhead, view) +
        outerHeight(doc.getElementById('headerMeta'), view) +
        runtimeSpace(doc, view) +
        outerHeight(doc.getElementById('viewsRoot'), view),
    );
    // A zero reading is "not laid out yet" (jsdom, a hidden page): leave the view's own fallback in place.
    if (chrome > 0 && chrome !== lastDrillChrome) {
      lastDrillChrome = chrome;
      root.style.setProperty(DRILL_CHROME_PROP, `${chrome}px`);
    }
  };

  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    if (entry.isIntersecting) delete dhead.dataset.stuck;
    else dhead.dataset.stuck = 'true';
  }) : null;
  io?.observe(sentinel);

  const watched = [dhead, doc.getElementById('headerMeta'), doc.getElementById('runtimeRoot'), doc.getElementById('viewsRoot')];
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
  for (const el of watched) if (el) ro?.observe(el);
  measure();

  return () => {
    io?.disconnect();
    ro?.disconnect();
    sentinel.remove();
    delete dhead.dataset.stuck;
    root.style.removeProperty(HEAD_HEIGHT_PROP);
    root.style.removeProperty(DRILL_CHROME_PROP);
  };
}
