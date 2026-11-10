/**
 * The baseline review's visual states (ui:UI-R39, @arch:BASELINE-REVIEW): the amber banner and the review overlay at the
 * four widths. Each state is the dashboard blocked on `baseline-review` with a row list, plus the clicks that open the
 * overlay and reach the state. Images are two small baseline PNGs inlined as data URIs, so the fixture page needs no
 * extra file; only the first rows carry them, which keeps the 48-row page small.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { populatedStateFor } from '../../src/ui/dashboard/renderFixtures.js';
import type { DashboardState } from '../../src/ui/dashboard/state.js';

type Decision = 'pending' | 'approved' | 'rejected';
type Status = 'added' | 'modified' | 'deleted';

interface Row {
  readonly index: number;
  readonly path: string;
  readonly label: string;
  readonly status: Status;
  readonly oldSrc: string | null;
  readonly newSrc: string | null;
  readonly decision: Decision;
  readonly reason: string | null;
}

export interface BaselineVariant {
  readonly id: string;
  readonly rows: () => readonly Row[];
  /** Selectors clicked in order after the load. */
  readonly clicks: readonly string[];
  readonly width?: number;
}

const OPEN = '[data-act="baseline-open"]';
const REJECT_OPEN = '[data-act="baseline-reject-open"]';
const REJECT_SEND = '[data-act="baseline-reject"]';
/** Rows that carry an image; the rest show the missing-image note. */
const WITH_IMAGES = 4;
const THEMES = ['dark', 'dark-grayscale', 'dark-reduced-motion', 'light', 'hc'] as const;
const NOW = '2026-08-12T10:00:00.000Z';

const dataUri = (file: string): string =>
  `data:image/png;base64,${readFileSync(fileURLToPath(new URL(`./__baselines__/dark/${file}`, import.meta.url))).toString('base64')}`;

const row = (index: number, label: string, over: Partial<Row> = {}): Row => ({
  index,
  path: `tests/visual/__baselines__/${label}`,
  label,
  status: 'modified',
  oldSrc: index < WITH_IMAGES ? dataUri('usage--loading.png') : null,
  newSrc: index < WITH_IMAGES ? dataUri('dashboard--loading.png') : null,
  decision: 'pending',
  reason: null,
  ...over,
});

/** `count` screenshots in the dark theme, named view--1 … view--n. */
const many = (count: number): Row[] => Array.from({ length: count }, (_, i) => row(i, `dark/view--${i + 1}.png`));

export const BASELINE_VARIANTS: readonly BaselineVariant[] = [
  { id: 'banner-open', rows: () => [...many(3), row(3, 'dark/done.png', { decision: 'approved' })], clicks: [] },
  { id: 'banner-rejected', rows: () => [row(0, 'dark/a.png', { decision: 'rejected', reason: 'clipped' }), row(1, 'dark/b.png')], clicks: [] },
  { id: 'overlay-1', rows: () => many(1), clicks: [OPEN] },
  { id: 'overlay-12', rows: () => many(12), clicks: [OPEN] },
  { id: 'overlay-48', rows: () => many(48), clicks: [OPEN] },
  { id: 'overlay-themes-5', rows: () => THEMES.map((t, i) => row(i, `${t}/dashboard.png`)), clicks: [OPEN] },
  { id: 'overlay-new-file', rows: () => [row(0, 'dark/fresh.png', { status: 'added', oldSrc: null })], clicks: [OPEN] },
  { id: 'overlay-deleted-file', rows: () => [row(0, 'dark/gone.png', { status: 'deleted', newSrc: null })], clicks: [OPEN] },
  { id: 'overlay-json', rows: () => [row(0, 'layout-known-failures.json', { path: 'tests/visual/layout-known-failures.json', oldSrc: null, newSrc: null })], clicks: [OPEN] },
  { id: 'overlay-reject-error', rows: () => many(3), clicks: [OPEN, REJECT_OPEN, REJECT_SEND] },
  { id: 'overlay-mid', rows: () => many(12), clicks: [OPEN], width: 600 },
  { id: 'overlay-narrow', rows: () => many(12), clicks: [OPEN], width: 380 },
  { id: 'overlay-tight', rows: () => many(12), clicks: [OPEN], width: 340 },
  { id: 'overlay-reject-tight', rows: () => many(3), clicks: [OPEN, REJECT_OPEN], width: 340 },
];

/** The uat stage blocked on a baseline review of `rows`. */
export function baselineState(rows: readonly Row[]): DashboardState {
  const s = populatedStateFor('uat');
  const cell = s.stepper.find((c) => c.stageKey === 'uat')!;
  return {
    ...s,
    // A short title: the dashboard header clips a long one at 480px, a failure the layout ledger holds only for its old routes.
    title: 'Update baselines',
    currentStage: { ...cell, blocked: { kind: 'baseline-review', reason: 'changed', at: NOW, resumable: false } },
    baselineReview: rows,
  } as unknown as DashboardState;
}
