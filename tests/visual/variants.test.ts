import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';
import { settingsRoutes } from './settingsRoutes.js';
import { layoutTargets, MANDATORY_VARIANTS, VARIANTS } from './variants.js';

const BASELINES = join(dirname(fileURLToPath(import.meta.url)), '__baselines__');
/** Theme folders that hold per-variant view screenshots. */
const VIEW_THEME_DIRS = ['dark', 'light', 'hc', 'dark-grayscale', 'dark-reduced-motion'];
/** Baselines owned by other specs (status.visual.ts), not by a view variant. */
const NON_VIEW_BASELINES = new Set(['status-primitives.png']);

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

  it('has no baseline PNG without a variant (stale)', () => {
    const known = new Set([...allVariants.map((x) => `${x.variant.baseline}.png`), ...NON_VIEW_BASELINES]);
    const stale = VIEW_THEME_DIRS.flatMap((theme) =>
      existsSync(join(BASELINES, theme))
        ? readdirSync(join(BASELINES, theme))
            .filter((f) => f.endsWith('.png') && !known.has(f))
            .map((f) => `${theme}/${f}`)
        : [],
    );
    expect(stale).toEqual([]);
  });

  it('runs layout geometry for every variant that does not opt out', () => {
    const settingsIds = new Set(settingsRoutes().map((r) => r.id));
    const targets = layoutTargets();
    expect(targets).toHaveLength(allVariants.filter((v) => !v.variant.skipLayout).length);
    for (const t of targets) {
      if (t.variant.layoutRouteId !== undefined) expect(settingsIds.has(t.id), t.id).toBe(true);
    }
    const ids = targets.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('opens every settings route through a variant', () => {
    const covered = new Set(VARIANTS.settings.flatMap((v) => (v.layoutRouteId === undefined ? [] : [v.layoutRouteId])));
    for (const r of settingsRoutes()) expect(covered.has(r.id), r.id).toBe(true);
  });
});
