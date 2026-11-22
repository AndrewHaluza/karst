import type { Stage } from '../../store/stages.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { SessionAction } from '../../agent/sessionAction.js';
import { STAGE_TITLE } from '../../model/stageBadge.js';
import { plural } from '../../model/notifyText.js';
import type { MergeGateState } from '../../workflow/mergeGate.js';
import type { StageKey } from '../../model/types.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { Glyph } from '../../model/glyph.js';
import type { RailNeeds } from '../../model/railNeeds.js';

/**
 * The expanded sidebar row's mini-dashboard. Collapsed rows stay scan-first;
 * expanding turns the row into a compact card: one headline (state word, age,
 * attempt), a few quiet fact lines, and at most one action strip.
 *
 * The host picks the state word and the facts (UI-R31). Times stay ISO strings
 * and the webview formats them, so a stale snapshot never shows a frozen "6m ago".
 * Every field added after the first release is optional, because a restored
 * older snapshot has none of them.
 */

/** The peek-only strip that is not part of the dashboard rail model. */
export type PeekNext =
  | { kind: 'create-follow-up'; label: string }
  | { kind: 'send-ci-failure'; label: string };

/** The agent line: who works the ticket, what it does, and when it was last active. */
export interface PeekAgent {
  /** Canonical agent-core id (claude/codex/antigravity/opencode). */
  provider: string;
  /** The ticket's launch model; null when inheriting the manifest default. */
  model: string | null;
  /** The activity word: working, waiting for you, or idle. */
  activity?: string;
  /** ISO time of the last agent hook; null before the first one. */
  activeAt?: string | null;
}

/** One repo row in the ship landing list: its PR number + whether it can merge. */
export interface PeekRepo {
  repo: string;
  number: number | null;
  state: 'ready' | 'conflict';
}

/** The gate fact line: its text and the tone that colors it. */
export interface PeekGates {
  text: string;
  tone: 'ok' | 'running' | 'failed';
}

/** The headline age. `for` is a running stage (`startedAt`); `ago` is a finished one (`endedAt`). */
export interface PeekSince {
  at: string;
  kind: 'for' | 'ago';
}

export interface TicketPeek {
  /** The state word. */
  title: string;
  /** The glyph color that the state word repeats. */
  tone?: Glyph;
  since?: PeekSince | null;
  /** The attempt number, only above one. */
  attempt?: number | null;
  gates?: PeekGates | null;
  repos?: PeekRepo[] | null;
  pausedNote?: string | null;
  agent?: PeekAgent | null;
  /** The action strip: the same `railNeeds()` result the dashboard rail shows. */
  needs?: RailNeeds | null;
  /** The peek-only strip (follow-up, CI failure). */
  next: PeekNext | null;
}

/** Everything `buildPeek` needs, gathered by the sidebar state builder. */
export interface PeekInput {
  stageCurrent: string | null;
  /** The ticket's CURRENT stage row; null before any stage exists. */
  current: Stage | null;
  agentState: string | null;
  sessionAction: SessionAction;
  worktrees: readonly { repo: string }[];
  servers: readonly { status: string }[];
  /** Every gate run for the ticket; filtered to the current stage here. */
  gateRuns: readonly GateRun[];
  /** The merge gate reading; computed only for a ship-stage ticket. */
  mergeGate: MergeGateState | null;
  /** The resolved launch core; null when no core is configured anywhere. */
  provider: AgentProvider | null;
  /** The ticket's per-ticket launch model; null = inherit the manifest default. */
  model: string | null;
  /** PRs (repo + number + status) backing the ship landing rows. */
  prs: readonly { repo: string; number: number | null; status: string | null }[];
  /** Repos whose stored CI rollup is failing AND the send action is available. */
  ciFailingRepos?: readonly string[];
  /** The ticket is paused. */
  paused: boolean;
  /** The row's glyph color. */
  glyph: Glyph;
  /** The `railNeeds()` result, gated the way the dashboard rail gates it. */
  needs: RailNeeds | null;
  /** `tickets.last_hook_at`, ISO; null before the first hook. */
  lastHookAt: string | null;
}

const GATE_KEYS: ReadonlySet<string> = new Set(['uat', 'review']);
const INTERACTIVE_KEYS: ReadonlySet<string> = new Set(['impl', 'fix']);
const PAUSED_NOTE = 'No stage starts until you resume';

/** The first line of a verdict, trimmed; null when blank. */
function firstLine(text: string | null | undefined): string | null {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/**
 * The most recent invocation's rows for a stage — the same greatest-`runAt`
 * reduction `model/inside/gates.ts` documents. Kept per-side on purpose; either
 * side's own tests catch drift.
 */
function latestBatch(runs: readonly GateRun[], stageKey: StageKey): GateRun[] {
  const mine = runs.filter((r) => r.stageKey === stageKey);
  const latest = mine.reduce<string | null>((max, r) => (max === null || r.runAt > max ? r.runAt : max), null);
  return latest === null ? [] : mine.filter((r) => r.runAt === latest);
}

/** One gate's bare name — everything before the ` (repo)` decoration. */
function bareGateName(name: string): string {
  return name.replace(/\s+\([^)]*\)$/, '');
}

/**
 * The gate fact line for every gate of the last run of the current stage.
 * A skipped gate is a recorded non-answer, never a pass. A gate with no exit
 * code counts as running only while the stage runs.
 */
function gatesLine(input: PeekInput, stage: StageKey, status: Stage['status']): PeekGates | null {
  const runs = latestBatch(input.gateRuns, stage).filter((r) => !r.skipped);
  let passed = 0;
  let running = 0;
  const failedNames: string[] = [];
  for (const r of runs) {
    if (r.exitCode === null) {
      if (status === 'running') running += 1;
    } else if (r.exitCode === 0) {
      passed += 1;
    } else {
      const name = bareGateName(r.gateName);
      if (!failedNames.includes(name)) failedNames.push(name);
    }
  }
  const failed = runs.filter((r) => r.exitCode !== null && r.exitCode !== 0).length;
  const parts: string[] = [];
  if (passed > 0 || (failed === 0 && running === 0)) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed: ${failedNames.join(', ')}`);
  if (running > 0) parts.push(`${running} running`);
  if (passed + failed + running === 0) return null;
  return { text: parts.join(' · '), tone: failed > 0 ? 'failed' : running > 0 ? 'running' : 'ok' };
}

/** A failed stage with no gate rows shows its verdict as one red line. */
function verdictLine(input: PeekInput): PeekGates | null {
  const text = firstLine(input.current?.verdict) ?? firstLine(input.current?.blockedReason);
  return text === null ? null : { text, tone: 'failed' };
}

/** The age: a finished stage ages from `endedAt`, a running one from `startedAt`. */
function sinceOf(current: Stage | null): PeekSince | null {
  if (current?.endedAt) return { at: current.endedAt, kind: 'ago' };
  if (current?.startedAt) return { at: current.startedAt, kind: 'for' };
  return null;
}

/** The agent line, only when a session exists and a core is known. */
function agentOf(input: PeekInput): PeekAgent | null {
  if (!input.provider || input.sessionAction.kind === 'start') return null;
  const activity =
    input.agentState === 'running' ? 'working' : input.agentState === 'waiting' ? 'waiting for you' : 'idle';
  return { provider: input.provider, model: input.model, activity, activeAt: input.lastHookAt };
}

/** One repo row per unmerged repo; conflicted repos precede their pending siblings. */
function shipRepos(
  input: PeekInput,
  gate: Extract<MergeGateState, { kind: 'conflicted' | 'awaiting' }>,
): PeekRepo[] {
  const numberByRepo = new Map<string, number | null>();
  for (const p of input.prs) {
    if (p.status === 'merged') continue;
    if (p.repo) numberByRepo.set(p.repo, p.number);
  }
  const rows: PeekRepo[] = [];
  const push = (repo: string, state: PeekRepo['state']): void => {
    rows.push({ repo, number: numberByRepo.get(repo) ?? null, state });
  };
  if (gate.kind === 'conflicted') {
    for (const repo of gate.repos) push(repo, 'conflict');
    for (const repo of gate.pending) push(repo, 'ready');
  } else {
    for (const repo of gate.repos) push(repo, 'ready');
  }
  return rows;
}

/** What one state family contributes: its word and its own facts. */
interface Family {
  title: string;
  gates?: PeekGates | null;
  repos?: PeekRepo[] | null;
  next?: PeekNext | null;
}

function shipFamily(input: PeekInput, status: Stage['status']): Family {
  if (status === 'failed') return { title: 'Ship failed', gates: verdictLine(input) };
  const gate = input.mergeGate;
  if (gate?.kind === 'conflicted') return { title: 'Merge conflict', repos: shipRepos(input, gate) };
  if (gate?.kind === 'awaiting') {
    const failing = input.ciFailingRepos ?? [];
    return {
      title: 'Awaiting merge',
      repos: shipRepos(input, gate),
      next: failing.length > 0 ? { kind: 'send-ci-failure', label: 'Send CI failure to agent' } : null,
    };
  }
  // `nothing-to-merge` (parked before the first confirm) or `merged` (landed; the sweep has not moved it yet).
  return { title: 'Ready to ship' };
}

function gateFamily(input: PeekInput, stage: StageKey, status: Stage['status']): Family {
  const label = STAGE_TITLE[stage];
  const gates = gatesLine(input, stage, status) ?? (status === 'failed' ? verdictLine(input) : null);
  if (status === 'failed') return { title: `${label} failed`, gates };
  if (status === 'running') return { title: 'Gates running', gates };
  if (status === 'passed') return { title: `${label} passed`, gates };
  if (status === 'bypassed') return { title: `${label} bypassed`, gates };
  return { title: `Awaiting ${label}`, gates };
}

function interactiveFamily(input: PeekInput, stage: StageKey, status: Stage['status']): Family {
  if (status === 'failed') return { title: `${STAGE_TITLE[stage]} failed`, gates: verdictLine(input) };
  return { title: input.agentState === 'idle' ? 'Session idle' : 'No active session' };
}

function scopeFamily(input: PeekInput): Family {
  if (input.worktrees.length === 0) return { title: 'Not scoped yet' };
  const running = input.servers.filter((s) => s.status === 'running').length;
  if (running > 0) return { title: plural(running, 'server running', 'servers running') };
  return { title: 'Scoped — ready to work' };
}

/** `Waiting for you`: the agent asked, did not start, ran out of quota, or the graph waits. */
function needsYou(needs: RailNeeds | null): boolean {
  return needs?.cta.kind === 'open-session' || needs?.cta.kind === 'graph-panel';
}

/**
 * The one derivation of the expanded row's summary. Precedence for the state
 * word, once: a live agent, a waiting agent (not for a running ship, whose
 * `waiting` is the driver's own headless work), a needs-you rail reading, a
 * pause, then the stage family (closed, done, ship, gate, impl/fix, scope).
 */
export function buildPeek(input: PeekInput): TicketPeek {
  const stage = input.stageCurrent as StageKey | null;
  const status = input.current?.status ?? 'pending';
  const shipRunning = stage === 'ship' && status === 'running';
  const terminal = stage === 'done' || stage === 'closed';

  let family: Family;
  if (stage === 'closed') {
    const reason = firstLine(input.current?.verdict);
    family = { title: 'Closed outside Karst', gates: reason === null ? null : { text: reason, tone: 'ok' } };
  } else if (stage === 'done') {
    family = { title: 'Shipped', next: { kind: 'create-follow-up', label: 'Create follow-up' } };
  } else if (input.agentState === 'running') {
    family = { title: 'Agent working' };
  } else if (input.agentState === 'waiting' && !shipRunning) {
    family = { title: 'Waiting for you' };
  } else if (needsYou(input.needs)) {
    family = { title: 'Waiting for you' };
  } else if (input.paused) {
    family = { title: 'Paused' };
  } else if (stage === 'ship') {
    family = shipFamily(input, status);
  } else if (stage !== null && GATE_KEYS.has(stage)) {
    family = gateFamily(input, stage, status);
  } else if (stage !== null && INTERACTIVE_KEYS.has(stage)) {
    family = interactiveFamily(input, stage, status);
  } else {
    family = scopeFamily(input);
  }

  const attempt = input.current?.attempt ?? 0;
  return {
    title: family.title,
    tone: input.glyph,
    since: sinceOf(input.current),
    attempt: attempt > 1 ? attempt : null,
    gates: family.gates ?? null,
    repos: family.repos ?? null,
    pausedNote: input.paused && !terminal ? PAUSED_NOTE : null,
    agent: agentOf(input),
    needs: terminal ? null : input.needs,
    next: family.next ?? null,
  };
}
