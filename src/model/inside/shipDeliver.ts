/**
 * The Deliver process (T1072): the ship ledger row that replaces the free Deliver block. It sits after Auto-fix and
 * before Merge. The host builds it from the facts it already reads (the undelivered counts and the auto-deliver
 * record), so the webview only renders it (UI-R31). It states known facts only: no step times, no engine record.
 */
import {
  deliverFailureLine, deliverHint, deliverTakeOverLine, shortSha, type DeliverFacts, type DeliverFailureFact,
} from './deliver.js';
import type { EvidenceRow, InsideProcessView, InsideStatus } from './types.js';

export interface DeliverRowInput {
  readonly notOnPr: number;
  readonly inSandbox: number;
  /** The host found commits to push; false when only the auto-deliver record is shown. */
  readonly canDeliver: boolean;
  readonly auto: DeliverFacts | null;
}

export const DELIVER_PUSH_TITLE = 'Push — sync the sandbox, then push the branch onto the open pull request';
const DETAIL_SEPARATOR = ' · ';

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function commitsLine(d: DeliverRowInput): string {
  const sandbox = d.inSandbox > 0 ? ` (${d.inSandbox} still in the sandbox)` : '';
  return `${d.notOnPr} commit${d.notOnPr === 1 ? '' : 's'} not on the PR${sandbox}`;
}

function failureRow(f: DeliverFailureFact, headSha: string | null): EvidenceRow {
  const where = f.headSha !== null && f.headSha === headSha ? 'on the current head' : 'on an older head';
  return {
    label: `Gate ${f.gate} failed`,
    detail: `exit ${f.exitCode} · ${where} ${shortSha(f.headSha)}`,
    status: 'fail',
    deliverDismiss: { gate: f.gate },
    ...(f.summary ? { output: f.summary } : {}),
  };
}

function evidenceRows(d: DeliverRowInput): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  const auto = d.auto;
  if (auto?.running) rows.push({ label: `Gate ${auto.running.n} of ${auto.running.m}`, detail: auto.running.gate, status: 'run' });
  if (auto) rows.push(...auto.failures.map((f) => failureRow(f, auto.headSha)));
  if (d.canDeliver) {
    rows.push({ label: 'Sync the sandbox', status: 'pending' });
    rows.push({ label: 'Push the branch', detail: 'after the sync', status: 'pending' });
  }
  return rows;
}

function rowStatus(d: DeliverRowInput): InsideStatus {
  if (d.auto?.running) return 'run';
  if (d.auto && d.auto.failures.length > 0) return 'fail';
  return d.canDeliver ? 'wait' : 'note';
}

export function deliverProcess(d: DeliverRowInput | null | undefined): InsideProcessView | undefined {
  if (!d || (!d.canDeliver && !d.auto)) return undefined;
  const auto = d.auto;
  const parts = [
    ...(d.canDeliver ? [commitsLine(d)] : []),
    ...(auto?.running ? [`gate ${auto.running.n} of ${auto.running.m}`] : []),
    ...(auto?.takenOver ? [deliverTakeOverLine(auto.takenOver)] : []),
  ];
  const hint = auto ? deliverHint(auto) : null;
  return {
    id: 'deliver',
    kind: 'deliver',
    label: 'Deliver',
    status: rowStatus(d),
    ...(parts.length > 0 ? { detail: parts.join(DETAIL_SEPARATOR) } : {}),
    ...(d.canDeliver ? { deliver: { title: hint ? `Push — ${lowerFirst(hint)}` : DELIVER_PUSH_TITLE } } : {}),
    // A run left a record: the row offers the stage console, as the Gate output button did.
    ...(auto ? { console: true as const } : {}),
    evidence: { kind: 'rows', rows: evidenceRows(d) },
  };
}
