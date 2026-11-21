import type { GettingStartedState, TutorialStep } from './state.js';
import { TUTORIAL_STEPS } from './state.js';
import type { SetupItem } from '../../init/status.js';
import { NO_MANIFEST_DETAIL } from '../../setup/checklist/compute.js';
import { buildAgentSetupView, type AgentSetupView } from '../../setup/checklist/panelView.js';
import type { ChecklistItem, ChecklistStatus } from '../../setup/checklist/types.js';

/**
 * The checked-in render fixture corpus for the gettingStarted webview.
 *
 * Every fixture is built ONLY from production presentation shapes
 * (`GettingStartedState`, `SetupItem`, `TutorialStep`) and is pure data:
 * no SQLite reads, no real worktrees, no executable action targets. Every
 * id-like field is `fixture:`-prefixed so no fixture control can resolve a
 * real host target. Deliberately long, hostile, untrusted labels and paths
 * (`<script>`, `&`, `"`) ensure render tests exercise escaping.
 *
 * The corpus covers five lifecycle scenarios: fresh (nothing done), partial
 * (some items complete), complete (all items done), empty (degenerate
 * zero-item state), and hostile (untrusted labels/paths per Key Decision 6).
 * Five more cover the host-computed 'Agent setup' list: open (a mixed run),
 * no-manifest (state a), checking (b), error (c) and done (d).
 */

/** The five lifecycle scenarios the corpus covers. */
export type GettingStartedScenario =
  | 'fresh'
  | 'partial'
  | 'complete'
  | 'empty'
  | 'hostile'
  | 'agent-open'
  | 'agent-no-manifest'
  | 'agent-checking'
  | 'agent-error'
  | 'agent-done';

/** Ordered vocabulary — deterministic iteration is part of the contract. */
export const GETTING_STARTED_SCENARIOS: readonly GettingStartedScenario[] = [
  'fresh',
  'partial',
  'complete',
  'empty',
  'hostile',
  'agent-open',
  'agent-no-manifest',
  'agent-checking',
  'agent-error',
  'agent-done',
];

/** One checked-in fixture: a scenario identity plus its full state. */
export interface GettingStartedRenderFixture {
  scenario: GettingStartedScenario;
  state: GettingStartedState;
}

/** The reserved numeric id band for fixture controls (Key Decision 5). */
const RESERVED_ID_START = 900001;

function fixtureItem(
  index: number,
  done: boolean,
  detailOverride?: string,
): SetupItem {
  return {
    id: `fixture:setup:${index}`,
    label: `Setup step ${index + 1}`,
    done,
    detail: detailOverride ?? (done ? null : `Detail for step ${index + 1}`),
  };
}

/** Hostile labels that exercise escaping — must contain the required strings. */
const HOSTILE_LABELS = [
  '<script>alert(1)</script>',
  'A & B "quoted" <b>',
  // A label of >=300 characters to exercise truncation / overflow.
  'X'.repeat(300),
] as const;

const HOSTILE_PATH = 'fixture:<script>&src/main.ts';

function hostileItem(index: number): SetupItem {
  const label = HOSTILE_LABELS[index % HOSTILE_LABELS.length]!;
  return {
    id: `fixture:setup:hostile:${index}`,
    label,
    done: index % 2 === 0,
    detail: index === 0 ? HOSTILE_PATH : null,
  };
}

/** The nine first-setup items as the CLI reports them; ids and titles are fixture data. */
function agentItems(statuses: readonly ChecklistStatus[], detail = (i: number) => `Detail for agent item ${i + 1}`): ChecklistItem[] {
  return statuses.map((status, i) => ({
    code: `fixture:agent:${i}`,
    section: 'general',
    title: `Agent item ${i + 1}`,
    required: i < 6,
    status,
    tool: 'set-general',
    detail: detail(i),
  }));
}

const NINE_TODO: readonly ChecklistStatus[] = Array.from({ length: 9 }, () => 'todo');
const FIXTURE_TIME = '09:41';

function agentView(over: Partial<Parameters<typeof buildAgentSetupView>[0]> & { items: ChecklistItem[] | undefined }): AgentSetupView {
  return buildAgentSetupView({ error: null, checking: false, updatedLabel: FIXTURE_TIME, ...over });
}

/** Build a tutorial step set — the production steps with fixture ids. */
function tutorialSteps(hostile = false): readonly TutorialStep[] {
  if (!hostile) {
    return TUTORIAL_STEPS.map((s) => ({
      ...s,
      id: `fixture:tutorial:${s.id}`,
    }));
  }
  return TUTORIAL_STEPS.map((s, i) => ({
    id: `fixture:tutorial:hostile:${s.id}`,
    label: HOSTILE_LABELS[i % HOSTILE_LABELS.length]!,
    description: i === 0 ? HOSTILE_PATH : s.description,
    action: s.action,
  }));
}

/** Fresh: nothing done — every checklist item incomplete. */
function freshState(): GettingStartedState {
  return {
    checklist: [
      fixtureItem(0, false),
      fixtureItem(1, false),
      fixtureItem(2, false),
    ],
    tutorial: tutorialSteps(),
  };
}

/** Partial: some items complete, some not. */
function partialState(): GettingStartedState {
  return {
    checklist: [
      fixtureItem(0, true),
      fixtureItem(1, false),
      fixtureItem(2, true),
      fixtureItem(3, false),
    ],
    tutorial: tutorialSteps(),
  };
}

/** Complete: every checklist item done. */
function completeState(): GettingStartedState {
  return {
    checklist: [
      fixtureItem(0, true),
      fixtureItem(1, true),
      fixtureItem(2, true),
    ],
    tutorial: tutorialSteps(),
  };
}

/** Empty: zero checklist items (degenerate host state). */
function emptyState(): GettingStartedState {
  return {
    checklist: [],
    tutorial: tutorialSteps(),
  };
}

/** Hostile: untrusted labels and paths per Key Decision 6. */
function hostileState(): GettingStartedState {
  return {
    checklist: [hostileItem(0), hostileItem(1), hostileItem(2)],
    agentSetup: agentView({
      items: agentItems(['todo', 'todo', 'done'], (i) => HOSTILE_LABELS[i % HOSTILE_LABELS.length]!).map((it, i) => ({
        ...it,
        title: HOSTILE_LABELS[(i + 1) % HOSTILE_LABELS.length]!,
      })),
      error: HOSTILE_LABELS[0],
    }),
    tutorial: tutorialSteps(true),
  };
}

/** A mixed run: done, open (required and optional) and skipped rows. */
function agentOpenState(): GettingStartedState {
  const statuses: ChecklistStatus[] = ['done', 'done', 'todo', 'todo', 'skipped', 'done', 'todo', 'todo', 'done'];
  return { ...partialState(), agentSetup: agentView({ items: agentItems(statuses) }) };
}

/** State (a): no karst.yml. Nine open rows and ONE detail line. */
function agentNoManifestState(): GettingStartedState {
  const items = agentItems(NINE_TODO, () => `${NO_MANIFEST_DETAIL} (ENOENT: no such file)`);
  return { ...freshState(), agentSetup: agentView({ items }) };
}

/** State (b): a run is in flight; the old rows stay. */
function agentCheckingState(): GettingStartedState {
  const statuses: ChecklistStatus[] = ['done', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo'];
  return { ...partialState(), agentSetup: agentView({ items: agentItems(statuses), checking: true }) };
}

/** State (c): the child failed or timed out. The old rows stay. */
function agentErrorState(): GettingStartedState {
  const statuses: ChecklistStatus[] = ['done', 'done', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo'];
  return {
    ...partialState(),
    agentSetup: agentView({ items: agentItems(statuses), error: 'setup checklist timed out after 120 s.' }),
  };
}

/** State (d): every required item is done; an optional one stays open. */
function agentDoneState(): GettingStartedState {
  const statuses: ChecklistStatus[] = ['done', 'done', 'done', 'done', 'done', 'done', 'todo', 'skipped', 'done'];
  return { ...completeState(), agentSetup: agentView({ items: agentItems(statuses) }) };
}

const STATE_BUILDERS: Readonly<Record<GettingStartedScenario, () => GettingStartedState>> = {
  fresh: freshState,
  partial: partialState,
  complete: completeState,
  empty: emptyState,
  hostile: hostileState,
  'agent-open': agentOpenState,
  'agent-no-manifest': agentNoManifestState,
  'agent-checking': agentCheckingState,
  'agent-error': agentErrorState,
  'agent-done': agentDoneState,
};

/**
 * Return a freshly built array of fixtures in GETTING_STARTED_SCENARIOS order.
 * A function, not a const, so no test can mutate a shared object.
 */
export function gettingStartedRenderFixtures(): GettingStartedRenderFixture[] {
  return GETTING_STARTED_SCENARIOS.map((scenario) => ({
    scenario,
    state: STATE_BUILDERS[scenario](),
  }));
}
