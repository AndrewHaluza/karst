import type { Store } from '../store/db.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../agent/processAssignment.js';
import type { Severity } from '../manifest/types.js';
import { SEVERITIES } from '../manifest/qualityDefaults.js';
import { listFindings } from '../store/reviewFindings.js';
import { getTicket } from '../store/tickets.js';
import { claimStallSuggestion, failStallSuggestion, saveStallSuggestion } from '../store/stallSuggestions.js';
import { reviewEpisodeStart } from './reviewStallRead.js';
import { parseStallSuggestion } from '../model/stallSuggestion.js';
import { classifyFailure, failureText } from '../agent/failureClass.js';
import { nowIso } from '../model/time.js';

/** The changed files of the ticket, by repo-relative path, and the stat text the prompt carries. */
export interface StallDiff {
  files: string[];
  stat: string;
}

export interface StallFinding {
  severity: Severity;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
}

/** One review run's blocking findings, worst first (@ui:FINDINGS-ORDER). */
export interface StallRound {
  runAt: string;
  attempt: number;
  findings: StallFinding[];
}

const DETAIL_CAP = 400;
const ROUND_FINDING_CAP = 12;

/** Every file in the diff is under `docs/`: the only diff that may carry the Accept option. */
export function isDocsOnlyDiff(files: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => f.startsWith('docs/') && !f.includes('..'));
}

/** Agent findings at or above `blockingSeverity`, per review run, since the last reset. */
export function stallRounds(store: Store, ticketId: number, blockingSeverity: Severity | 'none'): StallRound[] {
  if (blockingSeverity === 'none') return [];
  const floor = SEVERITIES.indexOf(blockingSeverity);
  const since = reviewEpisodeStart(store, ticketId);
  const byRun = new Map<string, StallRound>();
  for (const f of listFindings(store, ticketId)) {
    if (f.source !== 'agent' || SEVERITIES.indexOf(f.severity) > floor) continue;
    if (since !== null && f.runAt <= since) continue;
    const round = byRun.get(f.runAt) ?? { runAt: f.runAt, attempt: f.attempt, findings: [] };
    round.findings.push({ severity: f.severity, file: f.file, line: f.line, title: f.title, detail: f.detail });
    byRun.set(f.runAt, round);
  }
  return [...byRun.values()]
    .sort((a, b) => a.runAt.localeCompare(b.runAt))
    .map((r) => ({
      ...r,
      findings: [...r.findings].sort(
        (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (a.file ?? '').localeCompare(b.file ?? ''),
      ),
    }));
}

/** The number of blocking findings in the latest round: what Accept leaves unfixed. */
export function openBlockingCount(rounds: readonly StallRound[]): number {
  return rounds[rounds.length - 1]?.findings.length ?? 0;
}

function clip(text: string): string {
  const one = text.replace(/\s+/gu, ' ').trim();
  return one.length > DETAIL_CAP ? `${one.slice(0, DETAIL_CAP - 3)}...` : one;
}

/** The prompt is new and small (@arch:PRE-BASELINE); the existing reviewer prompts are untouched. */
export function buildStallPrompt(input: {
  description: string;
  acceptanceCheck: string;
  diffStat: string;
  rounds: readonly StallRound[];
}): string {
  const rounds = input.rounds
    .map((r, i) => {
      const shown = r.findings.slice(0, ROUND_FINDING_CAP).map((f) => {
        const where = f.file === null ? '' : ` ${f.file}${f.line === null ? '' : `:${f.line}`}`;
        return `- [${f.severity}]${where} ${clip(f.title)}: ${clip(f.detail)}`;
      });
      const more = r.findings.length > shown.length ? [`- ... ${r.findings.length - shown.length} more`] : [];
      return [`Round ${i + 1}:`, ...shown, ...more].join('\n');
    })
    .join('\n\n');
  return [
    'A code review keeps finding blocking problems and the fix loop does not converge.',
    'Find the likely cause. Propose 1 to 3 ways out. Read the code if you need to.',
    'Do not edit files. Do not run tests, builds, linters or any gate.',
    '',
    `Description:\n${input.description || '(none)'}`,
    '',
    `Acceptance check:\n${input.acceptanceCheck || '(none)'}`,
    '',
    `Diff stat:\n${input.diffStat || '(empty)'}`,
    '',
    `Review rounds, oldest first:\n${rounds || '(none)'}`,
    '',
    'Answer with one JSON object and nothing else:',
    '{"cause": "<one sentence, worded as likely>", "options": [{"label": "<short>", "note": "<instructions for the fix agent>", "description": "<optional, full replacement text>", "acceptanceCheck": "<optional, full replacement text>", "recommended": true}]}',
    'Rules: 1 to 3 options. Exactly one option has "recommended": true. Put "description" or "acceptanceCheck" only on an option that changes the scope, and give the full new text.',
    'The note must say that findings on removed scope no longer apply, when the option removes scope.',
  ].join('\n');
}

export interface GenerateStallDeps {
  store: Store;
  adapter: AgentAdapter;
  ticketId: number;
  /** A worktree of the ticket: the agent reads the code there. */
  cwd: string;
  blockingSeverity: Severity | 'none';
  diff: StallDiff;
  assignment?: ProcessAssignmentSnapshot | null;
  gateScripts?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  processRunId?: number | null;
  now?: () => string;
  debug?: (message: string) => void;
}

export type GenerateOutcome = 'ready' | 'failed' | 'skipped';

/**
 * Generate and store the suggestion for one park (`parkAt` = the block's stamp).
 * `skipped` = a live or finished row exists. Read-only (`reviewer` policy, AC-44),
 * bounded by the shared spawner (AC-11), tokens attributed at the seam (AC-14).
 * An unreadable answer counts as failed.
 */
export async function generateStallSuggestion(
  deps: GenerateStallDeps,
  parkAt: string,
  retry = false,
): Promise<GenerateOutcome> {
  const now = deps.now ?? nowIso;
  const { store, ticketId } = deps;
  if (!claimStallSuggestion(store, ticketId, parkAt, now(), retry)) {
    deps.debug?.(`[stall-suggestion] ticket ${ticketId}: skipped (already ${retry ? 'ready or running' : 'claimed'})`);
    return 'skipped';
  }
  const ticket = getTicket(store, ticketId);
  const prompt = buildStallPrompt({
    description: ticket.description ?? '',
    acceptanceCheck: ticket.intent ?? '',
    diffStat: deps.diff.stat,
    rounds: stallRounds(store, ticketId, deps.blockingSeverity),
  });
  try {
    const result = await deps.adapter.runHeadless({
      prompt,
      cwd: deps.cwd,
      model: deps.assignment?.model,
      effort: deps.assignment?.effort,
      signal: deps.signal,
      policy: 'reviewer',
      gateScripts: deps.gateScripts ?? [],
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      tracking: { callSite: 'stall-suggestion', ticketId, processRunId: deps.processRunId ?? undefined },
    });
    const parsed = parseStallSuggestion(result.raw);
    if (!parsed.ok) {
      failStallSuggestion(store, ticketId, parkAt, `The answer could not be read: ${parsed.reason}.`, false, now());
      deps.debug?.(`[stall-suggestion] ticket ${ticketId}: unreadable — ${parsed.reason}`);
      return 'failed';
    }
    saveStallSuggestion(store, ticketId, parkAt, parsed.value, now());
    return 'ready';
  } catch (e) {
    const usage = classifyFailure(e) === 'usage-limited';
    const text = failureText(e);
    failStallSuggestion(
      store,
      ticketId,
      parkAt,
      usage ? 'The agent hit a usage limit.' : `The agent call failed: ${text.split(/\r?\n/u)[0]?.slice(0, 160) ?? 'unknown error'}`,
      usage,
      now(),
    );
    deps.debug?.(`[stall-suggestion] ticket ${ticketId}: failed — ${text.slice(0, 200)}`);
    return 'failed';
  }
}
