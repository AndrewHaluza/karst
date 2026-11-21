import { NO_MANIFEST_DETAIL } from './compute.js';
import type { ChecklistItem, ChecklistStatus } from './types.js';

/**
 * The Getting Started view of the first-setup checklist. Pure: the host runs
 * `setup checklist` in a child process, parses its JSON here, and the webview
 * only draws the result.
 */

export type AgentSetupRowStatus = 'done' | 'open' | 'skipped';

export interface AgentSetupRow {
  code: string;
  title: string;
  required: boolean;
  status: AgentSetupRowStatus;
  /** The reason an item is open; null for a done or skipped item, and for every row while karst.yml is missing. */
  detail: string | null;
}

export interface AgentSetupSummary {
  done: number;
  total: number;
  skipped: number;
  requiredOpen: number;
}

export interface AgentSetupView {
  /** A run is in flight. The rows of the last run stay on screen. */
  checking: boolean;
  /** Time label of the last finished run; null before the first one. */
  updatedLabel: string | null;
  /** Why the last run failed; null when it worked. */
  error: string | null;
  /** The one line shown instead of nine copies while karst.yml is missing; null otherwise. */
  noManifest: string | null;
  rows: AgentSetupRow[];
  summary: AgentSetupSummary | null;
  /** Every required item is done or skipped. */
  allRequiredDone: boolean;
}

const STATUSES: ReadonlySet<string> = new Set<ChecklistStatus>(['todo', 'done', 'skipped']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toItem(raw: unknown): ChecklistItem {
  if (
    !isRecord(raw) ||
    typeof raw['code'] !== 'string' ||
    typeof raw['title'] !== 'string' ||
    typeof raw['required'] !== 'boolean' ||
    typeof raw['status'] !== 'string' ||
    !STATUSES.has(raw['status'])
  ) {
    throw new Error('setup checklist report has a malformed item');
  }
  return {
    code: raw['code'],
    title: raw['title'],
    required: raw['required'],
    status: raw['status'] as ChecklistStatus,
    section: (typeof raw['section'] === 'string' ? raw['section'] : 'general') as ChecklistItem['section'],
    tool: typeof raw['tool'] === 'string' ? raw['tool'] : '',
    detail: typeof raw['detail'] === 'string' ? raw['detail'] : '',
  };
}

/** The items of a `setup checklist` JSON report. A report of another shape throws: the run did not work. */
export function parseChecklistReport(stdout: string): ChecklistItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('setup checklist printed no JSON report');
  }
  const raw = isRecord(parsed) ? parsed['items'] : undefined;
  if (!Array.isArray(raw)) throw new Error('setup checklist report has no items');
  return raw.map(toItem);
}

export interface AgentSetupInput {
  /** The items of the last finished run; undefined before the first one. */
  items: readonly ChecklistItem[] | undefined;
  error: string | null;
  checking: boolean;
  updatedLabel: string | null;
}

const ROW_STATUS: Readonly<Record<ChecklistStatus, AgentSetupRowStatus>> = { todo: 'open', done: 'done', skipped: 'skipped' };

function isManifestMissing(items: readonly ChecklistItem[]): boolean {
  return items.length > 0 && items.every((i) => i.status === 'todo' && i.detail.startsWith(NO_MANIFEST_DETAIL));
}

export function buildAgentSetupView(input: AgentSetupInput): AgentSetupView {
  const items = input.items ?? [];
  const missing = isManifestMissing(items);
  const rows = items.map(
    (i): AgentSetupRow => ({
      code: i.code,
      title: i.title,
      required: i.required,
      status: ROW_STATUS[i.status],
      detail: i.status === 'todo' && !missing ? i.detail : null,
    }),
  );
  const requiredOpen = rows.filter((r) => r.required && r.status === 'open').length;
  return {
    checking: input.checking,
    updatedLabel: input.updatedLabel,
    error: input.error,
    noManifest: missing ? (items[0]?.detail ?? NO_MANIFEST_DETAIL) : null,
    rows,
    summary:
      rows.length === 0
        ? null
        : {
            done: rows.filter((r) => r.status === 'done').length,
            total: rows.length,
            skipped: rows.filter((r) => r.status === 'skipped').length,
            requiredOpen,
          },
    allRequiredDone: rows.length > 0 && requiredOpen === 0 && input.error === null && !missing,
  };
}
