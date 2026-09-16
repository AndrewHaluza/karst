// @vitest-environment jsdom
/**
 * Cross-view RUNTIME conformance sweep — the RUNTIME counterpart of
 * `conformance.test.ts`.
 *
 * Covers UI-R09, R10 (as rendered), R25, and R36 across every discovered
 * webview.  State-dependent RUNTIME rules (R11, R12, R13, R14, R14b, R15,
 * R17, R18, R26, R27, R32) are only asserted for the dashboard in
 * `dashboard/render.render.test.ts` until FEAT-37 supplies corpora for the
 * other seven views.
 *
 * R16 (closed discriminants), R22 (custom tooltip keyboard behaviour), R33
 * (host-side confirmation), and R37 (domain behaviour preserved) are not
 * claimed by this file — they are out of reach of a corpus-less sweep.
 *
 * jsdom CSSOM limits apply (see renderHarness.ts header): no var() resolution,
 * no calc() evaluation, no layout, no real focus ring, no paint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderWebview } from './testing/renderHarness.js';
import type { WebviewName } from '../model/webviewChains.js';

const UI_DIR = import.meta.dirname!;

const WEBVIEWS = readdirSync(UI_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(UI_DIR, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  })
  .sort();

const EXPECTED = [
  'dashboard',
  'diffs',
  'gettingStarted',
  'resources',
  'serverLogs',
  'settings',
  'sidebar',
  'ticketForm',
  'usage',
];

/**
 * Known RUNTIME violations per view — a RATCHET, not an allowlist.
 * Values may only shrink.  Each survivor has a comment naming the violation.
 */
const KNOWN_UNRESOLVED_K_CLASSES: Record<string, number> = {
  // k-agent-core: used in webview.html as a class on #agentCore but styled
  // via the agentIdentityCss() block which emits `.agent-identity` rules, not
  // `.k-agent-core`.  The class is a hook for future theming; it has no rule
  // today.  Remediation belongs in the agent identity component, not here.
  dashboard: 1,
  diffs: 0,
  gettingStarted: 0,
  resources: 0,
  serverLogs: 0,
  settings: 0,
  sidebar: 0,
  ticketForm: 0,
  usage: 0,
};

describe('RUNTIME conformance — discovery', () => {
  it('covers every webview that exists today', () => {
    expect(WEBVIEWS).toEqual(EXPECTED);
  });

  it('every discovered webview is rendered by the sweep', () => {
    expect(WEBVIEWS.length).toBe(EXPECTED.length);
  });

  it('has a k-class budget for every discovered webview', () => {
    for (const name of WEBVIEWS) {
      expect(KNOWN_UNRESOLVED_K_CLASSES[name], `${name} has no k-class budget`).toBeDefined();
    }
  });
});

/** Interaction hook predicate: data-act, data-action, or k-btn family class. */
const hasInteractionHook = (el: Element): boolean => {
  if (el.hasAttribute('data-act') || el.hasAttribute('data-action')) return true;
  const cls = el.className;
  if (typeof cls === 'string' && /\bk-btn\b/.test(cls)) return true;
  return false;
};

/** Native interactive element names. */
const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS']);

describe.each(WEBVIEWS)('RUNTIME conformance — %s', (name) => {
  let handle: ReturnType<typeof renderWebview>;

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  beforeAll(() => {
    handle = renderWebview(name as WebviewName);
  });

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  afterAll(() => {
    handle?.close();
  });

  it('script executes with zero errors (UI-R36)', () => {
    expect(handle.errors).toEqual([]);
  });

  it('every interaction hook is on a native element or has role+tabindex (UI-R09)', () => {
    const hookElements = handle.queryAll<HTMLElement>('[data-act], [data-action]');
    const btnElements = handle.queryAll<HTMLElement>('.k-btn, .k-btn-primary, .k-btn-secondary, .k-btn-ghost, .k-btn-danger');
    const all = [...new Set([...hookElements, ...btnElements])];

    const violations: string[] = [];
    for (const el of all) {
      const tag = el.tagName;
      if (INTERACTIVE_TAGS.has(tag)) continue;
      const role = el.getAttribute('role');
      const tabindex = el.getAttribute('tabindex');
      if (role && tabindex !== null) continue;
      violations.push(el.outerHTML.slice(0, 120));
    }
    expect(
      violations,
      `elements with interaction hooks but no role+tabindex: ${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('every visible input/select/textarea has a label (UI-R25)', () => {
    const inputs = handle.queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input:not([type="hidden"]), select, textarea',
    );
    const violations: string[] = [];
    for (const el of inputs) {
      const id = el.id;
      const hasWrappingLabel = !!el.closest('label');
      const hasForLabel = id ? !!handle.query(`label[for="${id}"]`) : false;
      const hasAriaLabel = el.hasAttribute('aria-label');
      const hasAriaLabelledby = el.hasAttribute('aria-labelledby');
      if (!hasWrappingLabel && !hasForLabel && !hasAriaLabel && !hasAriaLabelledby) {
        violations.push(el.outerHTML.slice(0, 120));
      }
    }
    expect(
      violations,
      `form controls without label association: ${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('every k- class in the DOM resolves to a CSSOM rule (UI-R10)', () => {
    // Collect all k- prefixed classes actually used in the DOM
    const kClasses = new Set<string>();
    for (const el of handle.queryAll('*')) {
      const cls = el.className;
      if (typeof cls !== 'string') continue;
      for (const c of cls.split(/\s+/)) {
        if (c.startsWith('k-')) kClasses.add(c);
      }
    }
    if (kClasses.size === 0) return; // vacuously true

    // Collect every selector text from the loaded CSSOM
    const selectors = handle.cssRules().map((r) => r.selectorText).join(' ');

    const unresolved: string[] = [];
    for (const cls of kClasses) {
      // A class resolves if any selector references it (as .className or in a compound selector)
      if (!selectors.includes(cls)) {
        unresolved.push(cls);
      }
    }

    const allowed = KNOWN_UNRESOLVED_K_CLASSES[name] ?? 0;
    expect(
      unresolved.length,
      `k- classes with no matching CSSOM rule: ${unresolved.join(', ')}`,
    ).toBeLessThanOrEqual(allowed);
  });
});
