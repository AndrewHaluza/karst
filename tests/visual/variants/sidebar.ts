/** The sidebar variants (ui:VISUAL-VARIANTS). */
import { PEEK_STATE_IDS, sidebarRenderFixtures } from '../../../src/ui/sidebar/renderFixtures.js';
import type { SidebarState, TicketRow } from '../../../src/ui/sidebar/state.js';
import { getCorpus } from '../corpora.js';
import { showcaseCorpus } from '../dbCorpus/showcase.js';
import {
  ALL_THEMES,
  LOADING,
  LONG_TITLE,
  fixtureCorpus,
  variant,
  type Variant,
  type VariantOpts,
  type ViewCorpus,
} from '../variantCore.js';

/** The Queue pane is collapsed by default; the shot needs it open (view state, never posted). */
const openQueue = (corpus: () => ViewCorpus): (() => ViewCorpus) => () => ({
  ...corpus(),
  viewState: { view: { collapsed: { queue: false } } },
});

/** The Activity pane is collapsed by default; the shot needs it open (view state, never posted). */
const openActivity = (corpus: () => ViewCorpus): (() => ViewCorpus) => () => ({
  ...corpus(),
  viewState: { view: { collapsed: { activity: false } } },
});

/**
 * SB-3 (T1318): a sidebar webview is about 300 px wide in a split editor group, so every sidebar shot records
 * that width; a tier variant names 320 or 460 px (@ui:RD-TIERS).
 */
const SIDEBAR_WIDTH = 300;
/** The three host tiers: the floor, the tight-tier step and the narrow tier (@ui:RD-TIERS). */
const SIDEBAR_TIERS = [['300', 300], ['320', 320], ['460', 460]] as const;
/** Every tier theme (@ui:UI-R57): dark, light and high contrast. */
const SIDEBAR_TIER_THEMES: readonly string[] = ALL_THEMES;
/** The state SHAPES also record the grayscale and reduced-motion projects (@ui:UI-R28, UI-R30). */
const SIDEBAR_SHAPE_THEMES: readonly string[] = ['dark', 'dark-grayscale', 'dark-reduced-motion'];

/** One sidebar variant at the real host width; a tier variant passes its own `width` (SB-3). */
const sidebarVariant = (id: string, corpus: () => ViewCorpus, opts: VariantOpts = {}): Variant =>
  variant('sidebar', id, corpus, { width: SIDEBAR_WIDTH, ...opts });

/** SB-3 (T1318): the long-content page carries the 100-character ticket title in its first row and its peek. */
const withLongTitle = (corpus: () => ViewCorpus): (() => ViewCorpus) => () => {
  const c = corpus();
  const msg = c.messages[0] as { type?: string; state?: SidebarState } | undefined;
  if (msg?.type !== 'state' || msg.state === undefined) return c;
  const rename = (row: TicketRow, index: number): TicketRow =>
    index === 0 ? { ...row, label: LONG_TITLE, peek: { ...row.peek, title: LONG_TITLE } } : row;
  const state = msg.state;
  return {
    ...c,
    messages: [
      {
        ...msg,
        state: {
          ...state,
          rows: state.rows.map(rename),
          sections: {
            current: state.sections.current.map(rename),
            awaitingReview: state.sections.awaitingReview.map(rename),
            recentlyDone: state.sections.recentlyDone.map(rename),
            olderDone: state.sections.olderDone.map(rename),
          },
        },
      },
    ],
  };
};

/** T1312: a Planning session starts collapsed; a draft-row shot opens its session first (view state, never posted). */
const openPlan = (sessionId: number): readonly string[] => [`.pt-twistie[data-plan-toggle="${sessionId}"]`];

export const sidebarVariants = (): Variant[] => {
  const s = fixtureCorpus.bind(null, 'sidebar', sidebarRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  /** One tier family: the same page at 300, 320 and 460 px in dark, light and hc (@ui:RD-TIERS). */
  const tiers = (id: string, corpus: () => ViewCorpus, opts: VariantOpts = {}): Variant[] =>
    SIDEBAR_TIERS.map(([tier, width]) => sidebarVariant(`${id}-${tier}`, corpus, { ...opts, width, themes: SIDEBAR_TIER_THEMES }));
  /** The peek rows open by their chevron; the shared `clicks` make the widths share one layout run. */
  const peekClicks = PEEK_STATE_IDS.map((id) => `[data-id="${id}"] .chev`);
  return [
    // The mandatory ids keep their names; every shot is the real 300 px host width (baseline `sidebar.png` kept).
    // T1365: the showcase page is the DB-built sidebar state (see the exporter), sanitized; the edge line is its own
    // side channel message, so `showcaseCorpus` sends it too.
    sidebarVariant('populated', () => showcaseCorpus('sidebar'), { baseline: 'sidebar', themes: ALL_THEMES }),
    // SB-3: the 15 real titles and the Activity rows of the probe, with Activity open (its three-row floor is checked).
    sidebarVariant('populated-300', openActivity(s('real-titles'))),
    // T1298: the attention line at one input and one failed ("1 needs you · 1 failed"); the same state all-sections carries.
    variant('sidebar', 'attention-one', s('all-sections'), { width: SIDEBAR_WIDTH, skipLayout: true }),
    sidebarVariant('empty', s('empty')),
    sidebarVariant('loading', LOADING),
    sidebarVariant('error', s('hostile'), { clicks: openPlan(91) }),
    // SB-2: the host build throws: the error line above the panes, and the pane skeleton below, never an empty list.
    sidebarVariant('host-error', LOADING, { replies: [{ type: 'error', message: 'fixture: the ticket store could not be read' }] }),
    sidebarVariant('long-content', withLongTitle(s('multi-facet'))),
    sidebarVariant('planning-deps', s('planning-deps'), { clicks: openPlan(17) }),
    sidebarVariant('priority', s('priority'), { clicks: openPlan(17) }),
    sidebarVariant('queue-empty', openQueue(s('empty'))),
    sidebarVariant('queue-populated', openQueue(s('queue'))),
    sidebarVariant('queue-long-content', openQueue(s('queue-long'))),
    // RD-1: the open Queue at every tier: the relation wraps, the row never scrolls sideways (@ui:UI-R43).
    ...tiers('queue-chips', openQueue(s('queue'))),
    sidebarVariant('activity-empty', openActivity(s('empty'))),
    sidebarVariant('activity-populated', openActivity(s('activity'))),
    sidebarVariant('activity-long-content', openActivity(s('activity-long'))),
    ...tiers('activity', openActivity(s('activity'))),
    sidebarVariant('subtasks', s('subtasks')),
    // SB-5: the stage pill reads the short key at 300/320 and the full word at 460 (@ui:UI-R49, UI-R51).
    ...tiers('stage-chip', s('planning-deps'), { clicks: openPlan(17) }),
    ...tiers('waits-on', s('waits-on')),
    ...tiers('planning-artifacts', s('planning-artifacts'), { hover: '[data-node="s95"] .pt-row' }),
    // UI-R28/UI-R28b: every state family's expanded row with its shape, at the floor, the tight step and the full word.
    sidebarVariant('peek-states-300', s('peek-states'), { width: 300, clicks: peekClicks, themes: SIDEBAR_SHAPE_THEMES }),
    sidebarVariant('peek-states-320', s('peek-states'), { width: 320, clicks: peekClicks }),
    sidebarVariant('peek-states-460', s('peek-states'), { width: 460, clicks: peekClicks }),
    // RD-4/RD-5: the two stage blocks as the peek headline; RD-3: a closed pull request.
    sidebarVariant('peek-blocked-300', s('peek-blocked'), { clicks: ['[data-id="900008"] .chev', '[data-id="900006"] .chev'] }),
    sidebarVariant('peek-pr-closed-300', s('peek-pr-closed'), { clicks: ['[data-id="900013"] .chev'] }),
    // SB-9: the filter state on screen; SB-8: a hovered row keeps its full stage and its title length.
    sidebarVariant('filtered-300', s('filtered')),
    // T1365 (@ui:SWEEP-BUDGET): the hover shot used to share the `populated` page's layout run. `populated` is now
    // the DB-built showcase corpus, so this page would add a second run of the fixture page; only the screenshot adds
    // value here (the hover state is not a layout step), and the showcase page keeps its own run.
    sidebarVariant('row-hover-300', () => getCorpus('sidebar'), { hover: '[data-id="900001"] .row', skipLayout: true }),
    sidebarVariant('cloud-sessions', s('cloud-sessions')),
    // T1091: the filter menu in a short window.
    sidebarVariant('filter-menu-bottom-edge', () => getCorpus('sidebar'), {
      skipLayout: true,
      width: 360,
      viewportHeight: 260,
      click: '.filter-menu .k-iconbtn',
    }),
  ];
};
