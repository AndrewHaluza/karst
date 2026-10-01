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
import { FIXTURE_STATE_PUSH } from './settings/app/testFixtures.js';

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
 * Known RUNTIME violations per view — a ratchet (values may only shrink).
 * Each survivor has a comment naming the violation.
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
 * Non-vacuity floor: minimum inputs and buttons each view must render per-kind.
 * NDL-126 §4 requires every view to render both inputs and buttons (N > 0 for each).
 * Settings: fixed parity measurement from vanilla view (phase 4 baseline).
 * Other views: measured from current sync render in the test environment.
 * Usage: measured after host sends state message (no longer special).
 */
const INTERACTION_FLOOR: Record<string, { inputs: number; buttons: number; inputsProbe?: 'focusable' }> = {
  dashboard: { inputs: 1, buttons: 17 },
  diffs: { inputs: 1, buttons: 3 },
  // gettingStarted: no form inputs; measured focusables 3
  gettingStarted: { inputs: 3, buttons: 3, inputsProbe: 'focusable' },
  // resources: no form inputs; measured focusables 4
  resources: { inputs: 4, buttons: 4, inputsProbe: 'focusable' },
  serverLogs: { inputs: 3, buttons: 4 },
  settings: { inputs: 52, buttons: 44 }, // vanilla view measured baseline (phase 4)
  sidebar: { inputs: 1, buttons: 4 },
  ticketForm: { inputs: 7, buttons: 12 },
  // usage: measured after seeded host state — no form inputs; focusable 8, buttons 8
  usage: { inputs: 8, buttons: 8, inputsProbe: 'focusable' },
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

  it('has a non-vacuity floor for every discovered webview', () => {
    for (const name of WEBVIEWS) {
      const floor = INTERACTION_FLOOR[name];
      expect(floor, `${name} has no non-vacuity floor`).toBeDefined();
      expect(floor!.inputs, `${name} inputs floor must be > 0, found ${floor!.inputs}`).toBeGreaterThan(0);
      expect(floor!.buttons, `${name} buttons floor must be > 0, found ${floor!.buttons}`).toBeGreaterThan(0);
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

/**
 * The settings nav sections, in nav order — the union of distinct interactive
 * controls across ALL tabs is the React equivalent of the vanilla whole-DOM
 * snapshot the floor was measured against (NDL-126 §4).
 */
const SETTINGS_SECTIONS = [
  'general',
  'git',
  'services',
  'approaches',
  'agents',
  'presets',
  'quality',
  'ticketing',
];

/** A stable identity for a control, so one control seen from two tabs (the
 *  shared topbar/nav, a drawer shared across tabs) is counted once. */
function controlKey(el: Element): string {
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return [
    el.tagName,
    el.getAttribute('name') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('data-section') ?? '',
    el.getAttribute('data-act') ?? '',
    text.slice(0, 60),
  ].join('|');
}

/** Assert container has at least N interactive elements per floor spec.
 *  For views with no form inputs, counts all native interactive tags (button, link, input, etc.) as "inputs".
 */
function assertInteractionFloor(
  container: Element | null,
  floor: { inputs: number; buttons: number; inputsProbe?: 'focusable' },
  viewName: string,
): void {
  if (!container) throw new Error(`${viewName}: container is null`);

  let inputCount: number;
  if (floor.inputsProbe === 'focusable') {
    // For views with no form inputs, count focusable elements
    inputCount = [...container.querySelectorAll('button, a, input:not([type="hidden"]), select, textarea')].length;
  } else {
    // Standard form inputs
    inputCount = [...container.querySelectorAll('input:not([type="hidden"]), select, textarea')].length;
  }

  const buttons = [...container.querySelectorAll('button')].length;

  if (inputCount < floor.inputs) {
    throw new Error(`${viewName}: expected at least ${floor.inputs} inputs, found ${inputCount}`);
  }

  if (buttons < floor.buttons) {
    throw new Error(`${viewName}: expected at least ${floor.buttons} buttons, found ${buttons}`);
  }
}

describe.each(WEBVIEWS)('RUNTIME conformance — %s', (name) => {
  let handle: ReturnType<typeof renderWebview>;
  /** Settings only: the union of distinct controls across all 8 tabs (parity floor). */
  let settingsSurface: { inputs: Set<string>; buttons: Set<string> } | undefined;

  beforeAll(async () => {
    // All views use renderWebviewReady: settings waits for React via data-karst-ready,
    // other views return immediately. Settings needs fake timers for React's microtask to run.
    if (name === 'settings') {
      const { vi } = await import('vitest');
      vi.useFakeTimers();
      try {
        handle = await renderWebviewReady(name as WebviewName);
        // The settings surface is the union of DISTINCT controls across every
        // tab — the React app mounts one section at a time, while the vanilla
        // DOM the floor was measured on carried all tabs at once. Push a
        // representative state (data-driven tabs render only with data) and
        // visit each nav section, so the parity floor (NDL-126 §4) measures the
        // full React surface, not the one tab the app shows first.
        handle.receive({ type: 'state', state: FIXTURE_STATE_PUSH });
        await Promise.resolve();
        await vi.runAllTimersAsync();

        const inputs = new Set<string>();
        const buttons = new Set<string>();
        for (const section of SETTINGS_SECTIONS) {
          if (section !== 'general') {
            handle.click(`[data-section="${section}"]`);
          }
          await Promise.resolve();
          await vi.runAllTimersAsync();
          for (const el of handle.queryAll('input:not([type="hidden"]), select, textarea')) {
            inputs.add(controlKey(el));
          }
          for (const el of handle.queryAll('button')) buttons.add(controlKey(el));
        }
        settingsSurface = { inputs, buttons };
      } finally {
        vi.useRealTimers();
      }
    } else {
      handle = await renderWebviewReady(name as WebviewName);
    }

    // Usage is data-driven; provide minimal state so it renders range controls
    if (name === 'usage') {
      handle.receive({
        type: 'state',
        state: {
          empty: false,
          rangeId: 'current',
          ranges: [{ id: 'current', label: 'Current' }],
          sort: 'total',
          sorts: [],
          totals: { calls: 1, totalDisplay: '100', totalExact: '100', inputDisplay: '50', outputDisplay: '50', reasoningDisplay: '0', cacheReadDisplay: '0', erroredCalls: 0, estimatedCalls: 0 },
          byStage: [],
          byModel: [],
          byProfile: [],
          tickets: [],
          page: { offset: 0, limit: 10, groups: 0, hasPrev: false, hasNext: false },
          error: null,
        },
      });
      // Yield to let jsdom process the message event and inline script
      await Promise.resolve();
    }
    // The settings arm mounts the React app and walks all eight sections for
    // the union floor; under a loaded machine that legitimately takes longer
    // than vitest's 10 s default (NDL-143 review round 1 — a hook timeout is
    // a failure guard, not a correctness window, so give it headroom).
  }, 30_000);

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


  it('renders at least the non-vacuity floor of inputs and buttons', () => {
    // Non-vacuity check: prevent tests from passing when view renders nothing.
    // Floor is measured from vanilla view and hardcoded per-view in INTERACTION_FLOOR.
    const floor = INTERACTION_FLOOR[name]!;
    if (name === 'settings') {
      // The React app mounts one tab at a time; the floor was measured against
      // the vanilla whole-DOM (all tabs at once). The parity proof is the union
      // across all 8 sections (NDL-126 §4), captured in beforeAll.
      expect(settingsSurface, 'settingsSurface must be captured for settings').toBeDefined();
      expect(settingsSurface!.inputs.size, 'settings React union inputs').toBeGreaterThanOrEqual(floor.inputs);
      expect(settingsSurface!.buttons.size, 'settings React union buttons').toBeGreaterThanOrEqual(floor.buttons);
      return;
    }
    expect(() => assertInteractionFloor(handle.document.body, floor, name)).not.toThrow();
  });

  it('proves non-vacuity: assertion fails on empty render', () => {
    // Prove floor assertions are not vacuous: the predicate must fail on an empty render.
    const floor = INTERACTION_FLOOR[name]!;

    const emptyHandle = renderWebview(name as WebviewName);
    const container = emptyHandle.query('body');
    expect(container, `${name}: body element must exist`).not.toBeNull();

    container!.innerHTML = '';
    expect(
      () => assertInteractionFloor(container, floor, name),
      `${name}: floor assertion must fail on empty render (inputs: ${floor.inputs}, buttons: ${floor.buttons})`,
    ).toThrow();

    emptyHandle.close();
  });
});
