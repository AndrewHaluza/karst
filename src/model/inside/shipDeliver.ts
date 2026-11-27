/**
 * The Deliver push (T1072, T1403): a later push of new commits onto the open pull request is part of the ship ledger's
 * Push row, not a row of its own. The host builds its rows and its summary from the facts it already reads (the
 * undelivered counts and the auto-deliver record), so the webview only renders them (UI-R31). It states known facts
 * only: the pre-push gates show one row per gate, in the UAT gate row shape, with their own time and duration.
 */
import {
  deliverHint, deliverTakeOverLine, shortSha, type DeliverFacts, type DeliverFailureFact, type DeliverGateFact,
} from './deliver.js';
import {
  formatDuration, formatExactDuration, formatTime, type EvidenceRow, type InsideStatus,
} from './types.js';

export interface DeliverRowInput {
  readonly notOnPr: number;
  readonly inSandbox: number;
  /** The host found commits to push; false when only the auto-deliver record is shown. */
  readonly canDeliver: boolean;
  readonly auto: DeliverFacts | null;
}

/** The Push row's own wording and controls, before the per-repository rows are added. */
export interface DeliverPushSummary {
  readonly status: InsideStatus;
  readonly detailParts: string[];
  readonly deliver?: { readonly title: string };
  readonly console?: true;
}

export const DELIVER_PUSH_TITLE = 'Push — sync the sandbox, then push the branch onto the open pull request';

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

const GATE_DETAIL: Readonly<Record<DeliverGateFact['status'], string>> = {
  pass: 'passed',
  run: 'running…',
  wait: 'waiting for a free slot',
  pending: 'queued',
  fail: '',
};

function gateDetail(g: DeliverGateFact): string {
  if (g.status !== 'fail') return GATE_DETAIL[g.status];
  return g.exitCode === null ? 'failed' : `exit ${g.exitCode}`;
}

/** The row's clock, from the same formatters the UAT gate rows use (empty fields omitted, never a placeholder). */
function timing(from: string | null, to: string | null): Pick<EvidenceRow, 'time' | 'duration' | 'durationExact'> | Record<string, never> {
  if (!from || !to) return {};
  const duration = formatDuration(from, to);
  const durationExact = formatExactDuration(from, to);
  return {
    time: formatTime(from),
    ...(duration ? { duration } : {}),
    ...(durationExact ? { durationExact } : {}),
  };
}

/** The start of the running gate: its own stamp, else the end of the gate that ran before it (the gates run in order). */
function liveStart(gates: readonly DeliverGateFact[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const ended = gates[i]?.endedAt;
    if (ended) return ended;
  }
  return null;
}

/** One planned gate of the current run, as the UAT and Review gates list theirs. */
function gateRow(
  g: DeliverGateFact,
  from: string | null,
  now: string,
  repoNameFor: ((repo: string) => string | undefined) | undefined,
): EvidenceRow {
  const repo = g.repo ? { repo: repoNameFor?.(g.repo) ?? g.repo } : {};
  const live = g.status === 'run';
  return {
    label: g.name,
    detail: gateDetail(g),
    status: g.status,
    ...repo,
    ...(g.status === 'wait' || g.status === 'pending' ? {} : timing(g.startedAt ?? (live ? from : null), live ? now : g.endedAt)),
    // Tells the webview this is a pre-push gate row (its live region), never a per-repository push row.
    deliverGate: true,
  };
}

/** The failures still on record that the CURRENT run did not list as its own fail row (same gate, same repo). */
function keptFailures(auto: DeliverFacts): EvidenceRow[] {
  const current = new Set((auto.gates ?? []).filter((g) => g.status === 'fail').map((g) => `${g.name}\u0000${g.repo}`));
  return auto.failures
    .filter((f) => !current.has(`${f.gate}\u0000${f.repo}`))
    .map((f) => failureRow(f, auto.headSha));
}

/**
 * The Push row's evidence rows for the Deliver push: the phase heading a base check runs under, one row per pre-push
 * gate, the kept failures that are not a fail row of the current run, and the pending sync/push rows.
 */
export function deliverPushRows(
  d: DeliverRowInput | null | undefined,
  now: string,
  repoNameFor?: (repo: string) => string | undefined,
): EvidenceRow[] {
  if (!d) return [];
  const auto = d.auto;
  const rows: EvidenceRow[] = [];
  const running = auto?.running ?? null;
  if (auto?.gates !== undefined) {
    if (running?.baseCheck === true) rows.push({ label: 'Check before push', role: 'phase' });
    auto.gates.forEach((g, i) => rows.push(gateRow(g, liveStart(auto.gates!, i), now, repoNameFor)));
  } else if (running) {
    // A record older than the gate facts: one running row, worded as before.
    rows.push({
      label: running.baseCheck === true ? `Check before push: gate ${running.n} of ${running.m}` : `Gate ${running.n} of ${running.m}`,
      detail: running.gate,
      status: 'run',
      deliverGate: true,
    });
  }
  if (auto) rows.push(...keptFailures(auto));
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

/** The Push row's status rule, detail parts and controls for the Deliver push; null when nothing is undelivered. */
export function deliverPushSummary(d: DeliverRowInput | null | undefined): DeliverPushSummary | null {
  if (!d || (!d.canDeliver && !d.auto)) return null;
  const auto = d.auto;
  const parts = [
    ...(d.canDeliver ? [commitsLine(d)] : []),
    ...(auto?.running ? [auto.running.baseCheck === true ? `checking before push: gate ${auto.running.n} of ${auto.running.m}` : `gate ${auto.running.n} of ${auto.running.m}`] : []),
    ...(auto?.takenOver ? [deliverTakeOverLine(auto.takenOver)] : []),
  ];
  const hint = auto ? deliverHint(auto) : null;
  return {
    status: rowStatus(d),
    detailParts: parts,
    ...(d.canDeliver ? { deliver: { title: hint ? `Push — ${lowerFirst(hint)}` : DELIVER_PUSH_TITLE } } : {}),
    // A run left a record: the row offers the stage console, as the Gate output button did.
    ...(auto ? { console: true as const } : {}),
  };
}
