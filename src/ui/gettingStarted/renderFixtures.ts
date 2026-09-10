import type { GettingStartedState, TutorialStep } from './state.js';
import { TUTORIAL_STEPS } from './state.js';
import type { SetupItem } from '../../init/status.js';

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
 * The corpus covers five scenarios: fresh (nothing done), partial (some
 * items complete), complete (all items done), empty (degenerate zero-item
 * state), and hostile (untrusted labels/paths per Key Decision 6).
 */

/** The five lifecycle scenarios the corpus covers. */
export type GettingStartedScenario =
  | 'fresh'
  | 'partial'
  | 'complete'
  | 'empty'
  | 'hostile';

/** Ordered vocabulary — deterministic iteration is part of the contract. */
export const GETTING_STARTED_SCENARIOS: readonly GettingStartedScenario[] = [
  'fresh',
  'partial',
  'complete',
  'empty',
  'hostile',
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
    tutorial: tutorialSteps(true),
  };
}

const STATE_BUILDERS: Readonly<Record<GettingStartedScenario, () => GettingStartedState>> = {
  fresh: freshState,
  partial: partialState,
  complete: completeState,
  empty: emptyState,
  hostile: hostileState,
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
