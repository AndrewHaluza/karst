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
import { renderWebview, renderWebviewReady } from './testing/renderHarness.js';
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

/**
 * Non-vacuity floor: minimum inputs + buttons each view must render.
 * A RATCHET: values may only stay same or increase. Measured against
 * vanilla (non-React) view today; settings floor measured once and
 * hardcoded below (phase 4 compares it as parity proof).
 * Measured via jsdom render in the test environment.
 */
const INTERACTION_FLOOR: Record<string, number> = {
  dashboard: 18, // inputs=1, buttons=17 (agent picker, filters, etc)
  diffs: 4, // inputs=1, buttons=3
  gettingStarted: 3, // buttons=3
  resources: 4, // buttons=4
  serverLogs: 0, // passive display, no interactive elements
  settings: 96, // inputs=52, buttons=44 (vanilla settings view, phase 3a baseline)
  sidebar: 5, // inputs=1, buttons=4
  ticketForm: 19, // inputs=7, buttons=12
  usage: 0, // data-driven buttons; renders 0 with empty state
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

  beforeAll(() => {
    // Phase 3a: React app not injected yet, use sync render for all views.
    // Phase 4+: settings will use renderWebviewReady() to await data-karst-ready.
    handle = renderWebview(name as WebviewName);
  });

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

  it('renders at least the non-vacuity floor of inputs + buttons', () => {
    // Non-vacuity check: prevent tests from passing when view renders nothing.
    // Floor is measured from vanilla view and hardcoded per-view in INTERACTION_FLOOR.
    const inputs = handle.queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input:not([type="hidden"]), select, textarea',
    );
    const buttons = handle.queryAll('button');
    const interactionCount = inputs.length + buttons.length;
    const floor = INTERACTION_FLOOR[name] ?? 0;

    if (floor > 0) {
      expect(
        interactionCount,
        `${name}: expected at least ${floor} interactions, found ${interactionCount} (inputs=${inputs.length}, buttons=${buttons.length})`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it('proves non-vacuity: assertion fails when #root is emptied', () => {
    // Prove the floor assertion is not vacuous by showing it fails
    // when we deliberately empty the render target.
    if (INTERACTION_FLOOR[name]! > 0) {
      const root = handle.query('#root');
      if (root) {
        root.innerHTML = '';
        const inputs = handle.queryAll('input:not([type="hidden"]), select, textarea');
        const buttons = handle.queryAll('button');
        const emptiedCount = inputs.length + buttons.length;
        const floor = INTERACTION_FLOOR[name]!;
        expect(emptiedCount, `${name} floor assertion should fail on empty root`).toBeLessThan(floor);
      }
    }
  });
});
