import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';
import { settingsRoutes } from './settingsRoutes.js';
import { layoutIdentity, layoutPlan, MANDATORY_VARIANTS, screenshotFullPage, VARIANTS } from './variants.js';

const BASELINES = join(dirname(fileURLToPath(import.meta.url)), '__baselines__');
/**
 * Baselines that a spec other than `pages.visual.ts` records, as exact
 * `(theme, filename)` pairs: `status.visual.ts` in the three status projects, and
 * `catalog.visual.ts` in `catalog`. A bare filename would let the same name sit in a
 * project that never writes it (`status-primitives.png` in `light`, which would then
 * never be compared) and would hide that `catalog/` has its own baseline.
 */
const NON_VIEW_BASELINES = new Set([
  'dark/status-primitives.png',
  'dark-grayscale/status-primitives.png',
  'dark-reduced-motion/status-primitives.png',
  'catalog/catalog.png',
]);

const allVariants = WEBVIEW_NAMES.flatMap((view) => VARIANTS[view].map((variant) => ({ view, variant })));

describe('variant registry coverage (ui:UI-R57)', () => {
  it('has a registry entry for every webview', () => {
    for (const view of WEBVIEW_NAMES) expect(VARIANTS[view]?.length, view).toBeGreaterThan(0);
  });

  it('declares every mandatory variant for every webview', () => {
    for (const view of WEBVIEW_NAMES) {
      const ids = VARIANTS[view].map((v) => v.id);
      for (const id of MANDATORY_VARIANTS) expect(ids, `${view} lacks '${id}'`).toContain(id);
    }
  });

  it('gives every variant a unique id and baseline per view', () => {
    for (const view of WEBVIEW_NAMES) {
      const ids = VARIANTS[view].map((v) => v.id);
      const baselines = VARIANTS[view].map((v) => v.baseline);
      expect(new Set(ids).size, `${view} ids`).toBe(ids.length);
      expect(new Set(baselines).size, `${view} baselines`).toBe(baselines.length);
    }
  });

  it('builds a corpus for every variant', () => {
    for (const { view, variant } of allVariants) {
      expect(Array.isArray(variant.corpus().messages), `${view}/${variant.id}`).toBe(true);
    }
  });

  it('has a baseline PNG for every variant in every required theme project', () => {
    const missing = allVariants.flatMap(({ view, variant }) =>
      variant.themes
        .filter((theme) => !existsSync(join(BASELINES, theme, `${variant.baseline}.png`)))
        .map((theme) => `${theme}/${variant.baseline}.png (${view}/${variant.id})`),
    );
    expect(missing).toEqual([]);
  });

  it('has exactly one baseline PNG per recorded (theme, variant) pair, and no others (SET-64, T1350)', () => {
    // Exact (theme, filename) pairs, not bare names: `diffs.png` is recorded by `dark`,
    // `light` and `hc`, so a leftover `dark-grayscale/diffs.png` is an orphan even though
    // the name is known. This also covers SET-64 (no `settings.png` in a status-only
    // project) and every directory under `__baselines__`, including `catalog/`.
    const expected = new Set([
      ...allVariants.flatMap(({ variant }) => variant.themes.map((theme) => `${theme}/${variant.baseline}.png`)),
      ...NON_VIEW_BASELINES,
    ]);
    const actual = readdirSync(BASELINES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        readdirSync(join(BASELINES, entry.name))
          .filter((file) => file.endsWith('.png'))
          .map((file) => `${entry.name}/${file}`),
      );
    const actualSet = new Set(actual);
    expect(actual.filter((pair) => !expected.has(pair)), 'stale baselines').toEqual([]);
    expect([...expected].filter((pair) => !actualSet.has(pair)), 'missing baselines').toEqual([]);
  });

  it('runs layout geometry for every variant that does not opt out, once per distinct page', () => {
    const settingsIds = new Set(settingsRoutes().map((r) => r.id));
    const { targets, sharedWith } = layoutPlan();
    const ids = targets.map((t) => t.id);
    const targetIds = new Set(ids);
    for (const { view, variant } of allVariants.filter((v) => !v.variant.skipLayout)) {
      const id = variant.layoutRouteId ?? `${view}/${variant.id}`;
      expect(targetIds.has(id) || targetIds.has(sharedWith.get(id) ?? ''), `${id} has no layout run`).toBe(true);
    }
    expect(targets.length + sharedWith.size).toBe(allVariants.filter((v) => !v.variant.skipLayout).length);
    for (const t of targets) {
      if (t.variant.layoutRouteId !== undefined) expect(settingsIds.has(t.id), t.id).toBe(true);
    }
    expect(targetIds.size).toBe(ids.length);
  });

  it('measures each page once: a variant that differs only in screenshot fields shares the earlier run', () => {
    const { targets, sharedWith } = layoutPlan();
    const keys = targets.filter((t) => t.variant.layoutRouteId === undefined).map((t) => layoutIdentity(t.view, t.variant));
    expect(new Set(keys).size).toBe(keys.length);
    // A tier variant opens its base case's page: the width only sizes the screenshot.
    expect(sharedWith.get('dashboard/inside-impl-running-mid')).toBe('dashboard/inside-impl-running');
    expect(sharedWith.get('dashboard/inside-impl-running-tight')).toBe('dashboard/inside-impl-running');
    // A different page keeps its own run.
    expect(sharedWith.has('dashboard/inside-impl-running')).toBe(false);
  });

  it('gives the same layout keys at another clock time (Playwright needs one test list in every worker)', () => {
    const keysAt = (ms: number): string[] => {
      vi.useFakeTimers({ now: ms, toFake: ['Date'] });
      try {
        return allVariants.filter((v) => v.variant.layoutRouteId === undefined).map(({ view, variant }) => layoutIdentity(view, variant));
      } finally {
        vi.useRealTimers();
      }
    };
    const t = Date.UTC(2026, 10, 13, 17, 22, 54, 482);
    expect(keysAt(t + 3_723_001)).toEqual(keysAt(t));
  });

  it('keys a layout page by corpus, widths and layout steps, never by screenshot fields or the clock', () => {
    const base = VARIANTS.dashboard.find((v) => v.id === 'inside-scope-running')!;
    const key = layoutIdentity('dashboard', base);
    expect(layoutIdentity('dashboard', { ...base, width: 360, themes: ['dark', 'light'], click: '#x', pills: ['Env'] })).toBe(key);
    expect(layoutIdentity('dashboard', { ...base, clicks: ['#open'] })).not.toBe(key);
    expect(layoutIdentity('dashboard', { ...base, id: 'populated' })).not.toBe(key); // other widths
    expect(layoutIdentity('dashboard', { ...base, corpus: () => ({ messages: [] }) })).not.toBe(key);
    const at = (iso: string) => ({ ...base, corpus: () => ({ messages: [{ type: 'state', state: { since: iso } }] }) });
    expect(layoutIdentity('dashboard', at('2026-11-13T17:22:54.482Z'))).toBe(layoutIdentity('dashboard', at('2026-11-13T17:22:54.484Z')));
  });

  it('opens every settings route through a variant', () => {
    const covered = new Set(VARIANTS.settings.flatMap((v) => (v.layoutRouteId === undefined ? [] : [v.layoutRouteId])));
    for (const r of settingsRoutes()) expect(covered.has(r.id), r.id).toBe(true);
  });

  it('maps the capture option to the Playwright fullPage flag', () => {
    expect(screenshotFullPage({ capture: 'viewport' })).toBe(false);
    expect(screenshotFullPage({})).toBe(true);
  });

  it('captures the viewport for the ticket-details drawer variants only', () => {
    const viewport = VARIANTS.dashboard.filter((v) => v.capture === 'viewport');
    expect(viewport).toHaveLength(12);
    for (const v of viewport) expect(v.id.startsWith('ticket-details-'), v.id).toBe(true);
    const all = Object.values(VARIANTS).flat();
    for (const v of all.filter((x) => x.id.startsWith('ticket-details-'))) expect(v.capture, v.id).toBe('viewport');
  });
});
