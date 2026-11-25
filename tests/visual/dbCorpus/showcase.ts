/**
 * The DB-built showcase corpus (T1365): the seeds the visual sweep's `populated`
 * variants render.
 *
 * `generated/{dashboard,sidebar,usage}.json` are produced by the exporter
 * (`scripts/export-visual-corpus.mjs` -> `export.ts`) from a seeded (or a real)
 * Karst SQLite database through the production state builders, then sanitized.
 * Reading them here is what makes the showcase baselines pin a state the
 * product actually emits, instead of a hand-written literal in
 * `src/ui/<view>/renderFixtures.ts` that can silently drift from it.
 *
 * Only the `populated` showcase variants read these files
 * (`tests/visual/variants.ts`). Every other variant keeps its
 * `renderFixtures` corpus, and the render-fixture modules themselves are
 * untouched, so the unit data-contract tests and the dashboard parity snapshot
 * stay as they are.
 *
 * The files are read from disk rather than imported as JSON modules: Playwright
 * loads this registry through its own TypeScript transform, where a JSON import
 * needs an import attribute that the bundler config does not set up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardState } from '../../../src/ui/dashboard/state.js';
import type { SidebarState } from '../../../src/ui/sidebar/state.js';
import type { UsageState } from '../../../src/ui/usage/state.js';
import type { ViewCorpus } from '../corpora.js';

/** The three SQLite-backed views the exporter covers (diffs reads git, not the store). */
export type ShowcaseView = 'dashboard' | 'sidebar' | 'usage';

/** The checked-in corpus directory, next to this module. */
export const SHOWCASE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'generated');

/** How the exporter's output maps back to the view's state type. */
interface ShowcaseState {
  dashboard: DashboardState;
  sidebar: SidebarState;
  usage: UsageState;
}

const CACHE = new Map<ShowcaseView, ShowcaseState[ShowcaseView]>();

function stateFor<V extends ShowcaseView>(view: V): ShowcaseState[V] {
  const hit = CACHE.get(view);
  if (hit !== undefined) return hit as ShowcaseState[V];
  const path = join(SHOWCASE_DIR, `${view}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `visual showcase: ${view}.json is missing — run npm run -s visual:corpus:export -- --seed`,
    );
  }
  const state = JSON.parse(raw) as ShowcaseState[V];
  CACHE.set(view, state);
  return state;
}

/**
 * The `ViewCorpus` the `populated` variant of a showcase view renders: one
 * `state` message carrying the DB-built state.
 *
 * The sidebar also gets the `edge` side-channel message its corpora entry sends
 * (`tests/visual/corpora.ts`): the super-thin resize edge line lives OUTSIDE the
 * state snapshot, so the screenshot would lose it otherwise.
 */
export function showcaseCorpus(view: ShowcaseView): ViewCorpus {
  const messages: unknown[] = [{ type: 'state', state: stateFor(view) }];
  if (view === 'sidebar') messages.push({ type: 'edge', side: 'right' });
  return { messages };
}
