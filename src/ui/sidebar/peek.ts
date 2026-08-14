import type { Stage } from '../../store/stages.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { SessionAction } from '../../agent/sessionAction.js';
import { STAGE_TITLE } from '../../model/stageBadge.js';
import type { MergeGateState } from '../../workflow/mergeGate.js';
import type { StageKey } from '../../model/types.js';
import type { AgentProvider } from '../../manifest/types.js';

/**
 * The expanded sidebar row's mini-dashboard (§ 869ehda7y). Collapsed rows stay
 * scan-first (chevron · glyph · name · stage); expanding turns the row into a
 * compact, state-aware surface that answers "what is happening with this ticket
 * NOW, and what can I do next" — never a compressed copy of the full dashboard.
 *
 * Everything here is derived from existing Karst state (`TicketWithStages`,
 * gate runs, the merge gate, servers/worktrees) and computed HOST-side: the
 * webview is standalone HTML and cannot import TS, so the strongest summary +
 * the suggested next step arrive pre-worded (UI-R31). The toolbar
 * (Spin / Terminal / Dashboard) is the STABLE, ticket-wide action set and is
 * not part of this model; `next` is the contextual primary CTA that sits above
 * it, and it may share intent with a toolbar action — the "no duplicated quick
 * actions" criterion is about the collapsed hover strip, which the expanded row
 * suppresses.
 */

/**
 * The contextual primary next action for the expanded row. Rendered as a
 * LABELED button above the toolbar — distinct from the toolbar's icon-only
 * Spin / Terminal / Dashboard, so a CTA that overlaps a toolbar action (e.g.
 * "Continue session" beside Terminal) is an emphasis, not a second copy.
 */
export type PeekNext =
  | { kind: 'open-session'; label: string }
  | { kind: 'create-follow-up'; label: string }
  | { kind: 'resolve-conflicts'; label: string; repo: string };

/** The agent identity for a context that names who is working (or would). */
export interface PeekAgent {
  /** Canonical agent-core id (claude/codex/antigravity/opencode). */
  provider: string;
  /** The ticket's launch model; null when inheriting the manifest default. */
  model: string | null;
}

/** One repo row in the ship landing list: its PR number + whether it can merge. */
export interface PeekRepo {
  repo: string;
  number: number | null;
  state: 'ready' | 'conflict';
}

/**
 * The expanded row's summary. `title` is the strongest current-state line;
 * `detail` is one small supporting context line (null when the headline is
 * complete); `next` is the suggested next step, null when the toolbar already
 * covers it (a normal wait — the mini-dashboard never invents a "do this" for
 * a state whose only move is to watch). `agent`/`progress`/`repos` are the
 * state-specific context rows (prototype v9): who is working, how far a running
 * gate is, and the per-repo landing state. Each is null/absent where the stage
 * has nothing to say — the webview renders only what is present.
 */
export interface TicketPeek {
  title: string;
  detail: string | null;
  next: PeekNext | null;
  /** Agent identity line, when the context has (or is worked by) a core. */
  agent?: PeekAgent | null;
  /** Gate progress, when a gate stage is actively running with recorded rows. */
  progress?: { passed: number; total: number } | null;
  /** Per-repo landing rows, when the ticket is awaiting merge/conflicted. */
  repos?: PeekRepo[] | null;
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
  /**
   * The resolved launch core for this ticket (ticket override, else the
   * manifest default); null when no core is configured anywhere.
   */
  provider: AgentProvider | null;
  /** The ticket's per-ticket launch model; null = inherit the manifest default. */
  model: string | null;
  /** Open PRs (repo + number + status) backing the ship landing rows. */
  prs: readonly { repo: string; number: number | null; status: string | null }[];
}

const GATE_KEYS: ReadonlySet<string> = new Set(['uat', 'review']);
const INTERACTIVE_KEYS: ReadonlySet<string> = new Set(['impl', 'fix']);

function sessionNext(sa: SessionAction): PeekNext {
  return { kind: 'open-session', label: `${sa.label} session` };
}

/** The agent identity for a context, when a core is known; null otherwise. */
function agentOf(input: PeekInput): PeekAgent | null {
  return input.provider ? { provider: input.provider, model: input.model } : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The most recent invocation's rows for a stage — the same greatest-`runAt`
 * reduction `model/inside/gates.ts` documents. Duplicated here rather than
 * imported for the reason that module gives for not sharing the store layer's:
 * a selection rule this simple is kept per-side, and drift between them is
 * caught by either side's own tests.
 */
function latestBatch(runs: readonly GateRun[], stageKey: StageKey): GateRun[] {
  const mine = runs.filter((r) => r.stageKey === stageKey);
  const latest = mine.reduce<string | null>(
    (max, r) => (max === null || r.runAt > max ? r.runAt : max),
    null,
  );
  return latest === null ? [] : mine.filter((r) => r.runAt === latest);
}

/** One gate's bare name — everything before the ` (repo)` decoration. */
function bareGateName(name: string): string {
  return name.replace(/\s+\([^)]*\)$/, '');
}

/** The gate stages (uat, review): the strongest state is the gate progress. */
function gatePeek(input: PeekInput, stage: StageKey, status: Stage['status']): TicketPeek {
  const label = STAGE_TITLE[stage];
  const runs = latestBatch(input.gateRuns, stage);
  let passed = 0;
  let failed = 0;
  for (const r of runs) {
    // A skipped gate (disabled for this ticket) or one whose script the repo
    // does not define is a recorded non-answer, never a verdict — left out of
    // the count exactly as the dashboard's gates process counts it.
    if (r.skipped || r.exitCode === null) continue;
    if (r.exitCode === 0) passed += 1;
    else failed += 1;
  }
  const firstFailed = runs.find((r) => !r.skipped && r.exitCode !== null && r.exitCode !== 0);

  if (status === 'failed') {
    return {
      title: `${label} failed`,
      detail: firstFailed
        ? `attempt ${input.current?.attempt ?? 0} · ${bareGateName(firstFailed.gateName)}`
        : null,
      next: sessionNext(input.sessionAction),
    };
  }
  if (status === 'running') {
    return {
      title: `${label} running`,
      detail:
        runs.length > 0 ? `${passed}/${runs.length} gates passed` : 'gates resolving per repository',
      next: null,
      // Who is executing the run and how far it has got — the two things a
      // running gate makes the user want to know.
      agent: agentOf(input),
      progress: runs.length > 0 ? { passed, total: runs.length } : null,
    };
  }
  if (status === 'passed') {
    return {
      title: `${label} passed`,
      detail: runs.length > 0 ? `${passed}/${runs.length} gates passed` : null,
      next: null,
    };
  }
  return { title: `Awaiting ${label}`, detail: null, next: null };
}

/**
 * The per-repo landing rows: one row per unmerged repo, its PR number (when a
 * current PR row is known) and whether it is conflict-blocked or ready to merge.
 * `conflicted` repos always precede their `pending` siblings, matching the
 * gate's own ordering, so the conflict is the first thing the list reads.
 */
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

/** The ship stage: the strongest state is the PR landing state. */
function shipPeek(input: PeekInput, status: Stage['status']): TicketPeek {
  if (status === 'failed') {
    return {
      title: 'Ship failed',
      detail: input.current?.verdict ?? input.current?.blockedReason ?? null,
      next: null,
    };
  }
  const gate = input.mergeGate;
  if (gate?.kind === 'conflicted') {
    const repo = gate.repos[0] ?? null;
    return {
      title: `${plural(gate.repos.length, 'merge conflict', 'merge conflicts')} in ${gate.repos.join(', ')}`,
      detail:
        gate.pending.length > 0
          ? `${plural(gate.pending.length, 'more PR pending', 'more PRs pending')}`
          : null,
      next: repo ? { kind: 'resolve-conflicts', label: 'Resolve conflicts', repo } : null,
      repos: shipRepos(input, gate),
    };
  }
  if (gate?.kind === 'awaiting') {
    return {
      title: plural(gate.repos.length, 'pull request awaiting merge', 'pull requests awaiting merge'),
      detail: gate.repos.length > 0 ? gate.repos.join(', ') : null,
      next: null,
      repos: shipRepos(input, gate),
    };
  }
  // `nothing-to-merge` (freshly parked pending the FIRST confirm click — no PR
  // exists yet) or `merged` (landed; the sweep has not moved the ticket yet).
  return {
    title: 'Ready to ship',
    detail: 'Confirm ship in the dashboard to open pull requests',
    next: null,
  };
}

/** impl/fix: the strongest state is the agent/session runtime. */
function interactivePeek(input: PeekInput): TicketPeek {
  // The configured core is the one working here — named on every reading, so
  // "who owns this" never depends on the session being live.
  const agent = agentOf(input);
  if (input.agentState === 'idle') {
    return {
      title: 'Session idle',
      detail: input.sessionAction.detail,
      next: sessionNext(input.sessionAction),
      agent,
    };
  }
  return {
    title: 'No active session',
    detail: input.sessionAction.detail,
    next: sessionNext(input.sessionAction),
    agent,
  };
}

/** scope (or no stage yet): the strongest state is readiness. */
function scopePeek(input: PeekInput): TicketPeek {
  if (input.worktrees.length === 0) {
    return {
      title: 'Not scoped yet',
      detail: input.sessionAction.detail,
      next: sessionNext(input.sessionAction),
    };
  }
  const running = input.servers.filter((s) => s.status === 'running').length;
  if (running > 0) {
    return {
      title: plural(running, 'server running', 'servers running'),
      detail: plural(input.worktrees.length, 'worktree ready', 'worktrees ready'),
      next: sessionNext(input.sessionAction),
    };
  }
  return {
    title: 'Scoped — ready to work',
    detail: input.sessionAction.detail,
    next: sessionNext(input.sessionAction),
  };
}

/**
 * The one derivation of the expanded row's mini-dashboard summary. Stage-aware
 * and sourced entirely from existing Karst state — the prototype's examples are
 * a reference, never hard-coded copy.
 *
 * A live or waiting agent outranks stage state: "someone is working this right
 * now" (or "stopped on you") is the strongest thing to say. The one exception is
 * a RUNNING ship, whose `waiting` is the driver's own headless work — the same
 * carve-out `ticketGlyph`'s `waitingWhileShipRuns` applies, so the reading can
 * never disagree with the row's glyph.
 */
export function buildPeek(input: PeekInput): TicketPeek {
  const stage = input.stageCurrent as StageKey | null;
  const status = input.current?.status ?? 'pending';
  const shipRunning = stage === 'ship' && status === 'running';

  if (input.agentState === 'running') {
    return {
      title: 'Agent running',
      detail: input.sessionAction.detail,
      next: sessionNext(input.sessionAction),
      agent: agentOf(input),
    };
  }
  if (input.agentState === 'waiting' && !shipRunning) {
    return {
      title: 'Agent waiting for input',
      detail: input.sessionAction.detail,
      next: sessionNext(input.sessionAction),
      agent: agentOf(input),
    };
  }

  if (stage === 'done') {
    return {
      title: 'Shipped',
      detail: null,
      next: { kind: 'create-follow-up', label: 'Create follow-up' },
    };
  }
  if (stage === 'ship') return shipPeek(input, status);
  if (stage !== null && GATE_KEYS.has(stage)) return gatePeek(input, stage, status);
  if (stage !== null && INTERACTIVE_KEYS.has(stage)) return interactivePeek(input);
  return scopePeek(input);
}
