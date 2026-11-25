import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';
import { baselineCollisions, type AllowedCollision } from './baselineDistinct.js';
import { settingsRoutes } from './settingsRoutes.js';
import { INSIDE_CASE_CLICK, layoutIdentity, layoutPlan, MANDATORY_VARIANTS, screenshotFullPage, VARIANTS } from './variants.js';

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

/**
 * Groups of variants that may record the same picture in one theme project, each with the reason
 * (@ui:VISUAL-VARIANTS). An entry that stops colliding fails the distinctness test, so remove it when its fix lands.
 */
const ALLOWED_BASELINE_COLLISIONS: readonly AllowedCollision[] = [
  {
    baselines: ['dashboard--inside-impl-running', 'dashboard-running'],
    reason:
      'The populated page (10-repository fixture) and the impl running case (2-repository fixture) draw the same page: ' +
      'the repository count is not on it.',
  },
  {
    baselines: ['dashboard--inside-ship-running', 'dashboard-waiting'],
    reason: 'The waiting scenario is the populated ship stage; the 10- and 2-repository fixtures draw the same page.',
  },
  {
    baselines: ['settings--populated', 'settings--route-general'],
    reason: 'The mandatory populated id and the route sweep both open the General route on the realistic settings.',
  },
  {
    baselines: ['settings--nav-agents-narrow', 'settings--roles-narrow-collapsed'],
    reason: 'The Agents route opens on the Roles tab with every row collapsed, so the nav shot equals the roles shot.',
  },
  {
    baselines: ['settings--nav-agents-tight', 'settings--roles-graph-tight', 'settings--roles-tight-collapsed'],
    reason: 'At 320 px all three open the Roles tab with no row selected, so the graph rows stay collapsed.',
  },
  {
    baselines: ['sidebar--activity-300', 'sidebar--activity-populated'],
    reason: 'The 300 px tier records light and hc too; the dark shot equals the single 300 px shot of the same page.',
  },
  {
    baselines: ['sidebar--planning-deps', 'sidebar--stage-chip-300'],
    reason: 'The 300 px tier records light and hc too; the dark shot equals the single 300 px shot of the same page.',
  },
  {
    baselines: ['sidebar--queue-chips-300', 'sidebar--queue-populated'],
    reason: 'The 300 px tier records light and hc too; the dark shot equals the single 300 px shot of the same page.',
  },
  {
    baselines: ['sidebar--empty', 'sidebar--queue-empty'],
    reason: 'An empty Queue pane draws collapsed, so the open-Queue view state gives the same page.',
  },
];

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

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

  it('records a distinct picture for every variant in each theme project, unless allow-listed (@ui:VISUAL-VARIANTS)', () => {
    const shots = allVariants.flatMap(({ variant }) =>
      variant.themes
        .map((theme) => ({ theme, file: join(BASELINES, theme, `${variant.baseline}.png`) }))
        .filter(({ file }) => existsSync(file))
        .map(({ theme, file }) => ({ theme, baseline: variant.baseline, hash: sha256(file) })),
    );
    const { unexpected, stale } = baselineCollisions(shots, ALLOWED_BASELINE_COLLISIONS);
    expect(unexpected, 'variants that record the same picture').toEqual([]);
    expect(stale, 'allow-list entries that no longer collide').toEqual([]);
  });

  it('gives the collapsed dashboard variants the step that shows their state (T1357)', () => {
    const dash = new Map(VARIANTS.dashboard.map((v) => [v.id, v]));
    for (const [key, click] of Object.entries(INSIDE_CASE_CLICK)) expect(dash.get(`inside-${key}`)?.click, key).toBe(click);
    expect(dash.get('runtime-shell-off-wide')?.runtimeOpen).toBe('more');
    expect(dash.get('runtime-docker-wide')?.runtimeOpen).toBeUndefined();
    expect(dash.get('inside-uat-passed-round-2')?.click).toBeUndefined();
    expect(dash.get('agent-popover-no-effort-model-wide')?.agentPopover?.model).toBe('opencode/kimi-k3-free');
    expect(dash.has('panel-wt-normal-wide')).toBe(false);
    expect(dash.has('subtask-blocked')).toBe(false);
    expect(VARIANTS.serverLogs.find((v) => v.id === 'empty')?.corpus()).not.toEqual(VARIANTS.serverLogs.find((v) => v.id === 'no-services')?.corpus());
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
