import type { DashboardState } from './state.js';
import type { InsidePreviewFixture } from './insideFixtures.js';
import type {
  InsideStageKey,
  InsideStageView,
  InsideDot,
  StageInside,
} from '../../model/inside/types.js';
import { STAGE_BLURBS, STAGE_TITLES } from '../../model/inside/types.js';
import type { StageKey } from '../../model/types.js';
import { STAGE_KEYS } from '../../model/types.js';

/**
 * Task 9 / Finding 1: the development-only Inside preview panel.
 *
 * The panel renders the PRODUCTION dashboard webview asset and speaks the
 * production render protocol: each fixture rides a host-built `DashboardState`
 * envelope delivered as a `{type:'state'}` message — the identical message a
 * real `pushState` ships — so the preview exercises the delivered Inside
 * renderer byte for byte. The development controls (stage/scenario, repo
 * count, widths) live in the toolbar OUTSIDE the delivered Inside DOM and are
 * revealed only by the `preview-fixtures` message, which the production host
 * never sends.
 *
 * The host boundary (`InsidePreviewHost`) keeps this module — and every test
 * of it — free of a runtime `vscode` import.
 */

/** A webview panel, narrowed to what the preview needs. */
export interface PreviewPanel {
  postMessage(message: unknown): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** The injected host seam: the real impl (extension.ts) renders the dashboard asset. */
export interface InsidePreviewHost {
  createPanel(title: string, html: string): PreviewPanel;
}

export const INSIDE_PREVIEW_TITLE = 'Karst: Inside Preview (Development)';

/** The six inside stage keys, in presentation order. */
const INSIDE_STAGE_KEYS: readonly InsideStageKey[] = [
  'scope',
  'impl',
  'uat',
  'review',
  'ship',
  'done',
];

/** One fixture as the webview toolbar consumes it — snapshot already attached. */
export interface PreviewFixturePayload {
  id: string;
  label: string;
  repositoryCount: InsidePreviewFixture['repositoryCount'];
  scenario: InsidePreviewFixture['scenario'];
  stage: InsideStageKey;
  state: DashboardState;
}

/** An empty, renderable view for a stage the fixture does not cover. */
function emptyStageView(key: InsideStageKey): InsideStageView {
  return {
    stageKey: key,
    title: STAGE_TITLES[key],
    dot: 'pend' as InsideDot,
    clock: 'has not run yet',
    processes: [],
    blurb: STAGE_BLURBS[key],
  };
}

/** An empty legacy-strip shell for every runtime stage the webview may render. */
function emptyStageInside(): Record<StageKey, StageInside> {
  const out = {} as Record<StageKey, StageInside>;
  for (const key of STAGE_KEYS) {
    out[key] = {
      stageKey: key,
      title: STAGE_TITLES[key],
      dot: 'pend' as InsideDot,
      clock: '',
      ops: [],
      blurb: STAGE_BLURBS[key],
    };
  }
  return out;
}

/**
 * Wrap one fixture's view in the dashboard snapshot envelope the webview's
 * render functions consume. Everything outside `insideViews` is neutral: an
 * empty rail, no stepper, no servers, no worktrees, no PRs — the preview shows
 * the Inside component and nothing else. `ticketId` 0 is a placeholder: the
 * preview never queries the store, and the webview only posts ids back for
 * actions the fixture cannot dispatch (`fixture:` ids resolve nowhere).
 */
export function previewStateFor(fixture: InsidePreviewFixture): DashboardState {
  const stage = fixture.stage;
  const insideViews = {} as Record<InsideStageKey, InsideStageView>;
  for (const key of INSIDE_STAGE_KEYS) {
    insideViews[key] = key === stage ? fixture.view : emptyStageView(key);
  }
  return {
    ticketId: 0,
    key: `preview-${fixture.id}`,
    title: fixture.label,
    stageCurrent: stage,
    agentState: null,
    agentSession: {
      provider: 'claude',
      providerLabel: 'Claude Code',
      modelId: null,
      modelLabel: 'Agent default',
      canSwitch: false,
    },
    stepper: [],
    currentStage: null,
    now: { text: `Preview fixture: ${fixture.label}` },
    servers: [],
    hasRunnableRepos: false,
    worktrees: [],
    prs: [],
    mergeChecks: [],
    provider: null,
    sourceRef: null,
    ticketUrl: null,
    brief: null,
    rail: { main: [] },
    inside: emptyStageInside(),
    insideViews,
    presentedStage: stage,
    approach: null,
  };
}

/** The wire payload for one fixture, deterministic from the fixture alone. */
export function previewPayloadFor(fixture: InsidePreviewFixture): PreviewFixturePayload {
  return {
    id: fixture.id,
    label: fixture.label,
    repositoryCount: fixture.repositoryCount,
    scenario: fixture.scenario,
    stage: fixture.stage,
    state: previewStateFor(fixture),
  };
}

/**
 * Open the development preview: create the panel through the injected host,
 * seed it with the fixture list (each carrying its host-built snapshot), then
 * push the first fixture through the same `{type:'state'}` message a real
 * dashboard push uses. The `html` argument is the seam the interface documents
 * — the real host binds the injected dashboard webview asset; a test fake
 * records the call shape.
 */
export function openInsidePreview(
  host: InsidePreviewHost,
  fixtures: readonly InsidePreviewFixture[],
): void {
  const panel = host.createPanel(INSIDE_PREVIEW_TITLE, '');
  panel.postMessage({ type: 'preview-fixtures', fixtures: fixtures.map(previewPayloadFor) });
  const first = fixtures[0];
  if (first) panel.postMessage({ type: 'state', state: previewStateFor(first) });
}
