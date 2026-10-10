/**
 * Browser-side collector for the layout-sanity gate: serializes every RENDERED
 * element (display != none, visibility != hidden, opacity > 0, non-zero box)
 * into the `LayoutSnapshot` the pure checks judge. Self-contained on purpose —
 * Playwright serializes the function into the page.
 */
import type { Page } from '@playwright/test';
import type { LayoutSnapshot } from '../../src/ui/layout/layoutChecks.js';

export function collectSnapshot(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate((): LayoutSnapshot => {
    const IMPLICIT: Record<string, string> = {
      table: 'table', tr: 'row', td: 'cell', th: 'columnheader', button: 'button',
    };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT']);
    const ids = new Map<Element, number>();
    const elements: LayoutSnapshot['elements'][number][] = [];

    const roleOf = (e: Element): string | null => {
      const explicit = e.getAttribute('role');
      if (explicit) return explicit;
      const tag = e.tagName.toLowerCase();
      if (tag === 'a' && e.hasAttribute('href')) return 'link';
      return IMPLICIT[tag] ?? null;
    };
    const pathOf = (e: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = e; n && n !== document.documentElement; n = n.parentElement) {
        const tag = n.tagName.toLowerCase();
        if (n.id) {
          parts.unshift(`${tag}#${n.id}`);
          break;
        }
        const index = n.parentElement ? Array.from(n.parentElement.children).indexOf(n) + 1 : 1;
        const cls = Array.from(n.classList).slice(0, 2).map((c) => `.${c}`).join('');
        parts.unshift(`${tag}${cls}:nth-child(${index})`);
      }
      return parts.join(' > ');
    };
    const nearestCollected = (e: Element): number | null => {
      for (let n = e.parentElement; n; n = n.parentElement) {
        const id = ids.get(n);
        if (id !== undefined) return id;
      }
      return null;
    };

    for (const e of Array.from(document.body.querySelectorAll('*'))) {
      if (SKIP.has(e.tagName) || e.closest('svg') !== null && e.tagName.toLowerCase() !== 'svg') continue;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.display === 'contents') continue;
      if (cs.visibility === 'hidden' || Number(cs.opacity) <= 0) continue;
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const id = elements.length;
      ids.set(e, id);
      elements.push({
        id,
        parentId: nearestCollected(e),
        path: pathOf(e),
        tag: e.tagName.toLowerCase(),
        role: roleOf(e),
        inputType: e instanceof HTMLInputElement ? e.type.toLowerCase() : null,
        rect: { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height },
        position: cs.position,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        textOverflow: cs.textOverflow,
        scrollW: e.scrollWidth,
        clientW: e.clientWidth,
        scrollH: e.scrollHeight,
        clientH: e.clientHeight,
        colSpan: e instanceof HTMLTableCellElement ? e.colSpan : Number(e.getAttribute('aria-colspan') ?? 1),
        exposesText:
          e.hasAttribute('aria-label') || e.hasAttribute('aria-describedby') || e.hasAttribute('aria-expanded'),
        hasText: (e.textContent ?? '').trim().length > 0,
        region: e.getAttribute('data-region'),
        primaryAction: e.classList.contains('k-btn--primary'),
      });
    }
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      elements,
    };
  });
}
