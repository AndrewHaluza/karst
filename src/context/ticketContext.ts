/**
 * The ticket-context aggregator (§ context loader): one pure function that
 * gathers everything a session needs about a ticket — the authored prompt, the
 * fetched brief, selected repos, and the live worktrees/branches, running
 * servers, PRs, and named service definitions — into one serializable shape,
 * plus a deterministic markdown renderer.
 *
 * Two consumers share it: the extension bakes the rendered markdown into the
 * launch seed (in-process, no round-trip), and the `karst context` CLI prints
 * it (JSON or markdown) so a running session can re-pull fresh state on demand.
 * vscode-free and driver-agnostic (takes a `Store`), so both paths are testable.
 */

import { isQueuedSubtask } from '../model/subtask.js';
import type { AttachmentKind } from '../attachments/kinds.js';
import { attachmentPath } from '../attachments/paths.js';
import type { Store } from '../store/db.js';
import { STAGE_KEYS, type StageKey } from '../model/types.js';
import type { Severity } from '../manifest/types.js';
import { listAttachments } from '../store/attachments.js';
import { landedBlockerOutcomes, renderBlockerOutcome, type BlockerOutcome } from '../store/blockerOutcome.js';
import { unreadCount } from '../store/ticketMessages.js';
import { NOTE_INDEX_TITLE_MAX, unreadNoteIndex } from '../store/bulletinNotes.js';
import { getTicket, listSubtasks, type TicketWithStages } from '../store/tickets.js';
import {
  listWorktreesByTicket,
  listServersByTicket,
  listPrsByTicket,
} from '../store/dashboard.js';
import { listMergeChecksByTicket } from '../store/mergeChecks.js';
import { summarizeMergeCheck, type MergeCheckView } from '../model/mergeCheckView.js';
import { listGateRuns } from '../store/gateRuns.js';
import { latestFindingBatch } from '../store/reviewFindings.js';
import { latestBatch } from '../model/inside/gates.js';
import { truncateToBudget, SEED_BUDGETS } from '../agent/seedBudget.js';
import { latestStageRun, previousStageRun } from '../store/stageRuns.js';
import { isMarkerStage } from '../agent/markerStage.js';
import { MARKER_REFUSED, GATE_DECIDED_BY_EXIT_CODES } from '../agent/promptText.js';
import type { Manifest, RepositoryDef } from '../manifest/types.js';
import { unitsOf } from '../manifest/runnable.js';

export interface TicketContextWorktree {
  repo: string;
  path: string;
  branch: string | null;
  baseRef: string | null;
  source?: 'override' | 'parent' | 'manifest';
  depsMode: string;
}

export interface TicketContextServer {
  service: string;
  host: string | null;
  port: number | null;
  status: string;
}

export interface TicketContextPr {
  repo: string;
  number: number | null;
  url: string | null;
  status: string | null;
  /**
   * Whether this repo's branch still merges into its base, as of the last ship.
   * Optional and omitted entirely when never checked — a ticket shipped before
   * this existed renders exactly as it did before, and never as "clean".
   */
  mergeCheck?: MergeCheckView;
}

/**
 * One image or video attached to the ticket's prompt, as the agent sees it.
 *
 * `path` is absolute — the agent opens it directly, so a relative path would be
 * resolved against whatever cwd the session happens to have. `name` is what the
 * user called the file, which is frequently the only clue what a screenshot
 * shows; the stored name is a hash and says nothing.
 */
export interface TicketContextAttachment {
  kind: AttachmentKind;
  path: string;
  name: string;
}

/** One recorded gate from the current (or explaining) stage's latest batch. */
export interface TicketContextGate {
  name: string;
  exitCode: number | null;
  /**
   * v24: carried separately from `exitCode` for the agent's sake as much as a
   * human's — an agent told only "no exit code" would try to fix a
   * package.json that is perfectly fine when the gate was actually disabled
   * for this ticket.
   */
  skipped: boolean;
  /**
   * v46: a bounded excerpt of the failing gate's own output — the "what failed
   * (file, line, rule)" a linter or test runner printed. Present only when the
   * gate FAILED and a summary was captured; null for a pass/skip/absent row
   * and for pre-v46 evidence. The full output stays in the artifact log named
   * by `artifactPath`.
   */
  summary: string | null;
}

/** One review finding from the latest batch — the same fields `fixBrief.ts` renders. */
export interface TicketContextFinding {
  severity: Severity;
  repo: string;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
}

/**
 * Read-only stage/gate/finding state for a session re-pulling context on
 * demand (§ context loader, closes G15: "an agent re-pulling context mid-fix
 * cannot see which gate failed").
 *
 * Ordinarily the ticket's CURRENT stage. The one exception is `fix`, which
 * records no gate evidence of its own — there this names the most recently
 * FAILED gate stage (`uat` or `review`) instead, since that is the question a
 * fix session actually needs answered. `gates`/`findings` are the LATEST
 * recorded batch only (never full history — `karst context` is current
 * state, not an audit log); `findings` is empty for anything but `review`,
 * since only review's Lane B ever writes them.
 */
export interface TicketContextStage {
  stageKey: string;
  status: string;
  verdict: string | null;
  blocked: { kind: string; reason: string } | null;
  gates: TicketContextGate[];
  findings: TicketContextFinding[];
  /**
   * Where this stage's log was written, when it wrote one. A stage that says
   * only "running" and names no artifact leaves a session with nothing to open
   * but the SQLite file, which is exactly what the reporting session resorted to.
   */
  artifactPath: string | null;
  /**
   * The stage's most recent gate-run INVOCATION, or null when none was ever
   * recorded (nothing has run since v25, or this is not a gate stage).
   *
   * Distinct from `stages.started_at`, which is written when the stage is
   * ENTERED and never again — so a stage re-run by a later sweep reported an age
   * 25 minutes older than the run actually in flight, and no consumer could tell.
   * This is the run's own clock, and its status is what separates the three
   * things "running with no gate rows" used to mean at once: never started (no
   * run), in flight (`running`), destroyed (`stale`).
   */
  run: TicketContextStageRun | null;
  /**
   * True when the agent may advance this stage itself with the done marker
   * (`impl`/`fix`). False at a gate stage, whose verdict comes from exit codes —
   * firing the marker there is REFUSED, and the seed doc still told the agent to
   * try, so an agent that trusted it reported a ticket advanced that was not.
   */
  agentCanAdvance: boolean;
}

/** One gate-run invocation, as a session needs to read it. */
export interface TicketContextStageRun {
  status: string;
  outcome: string | null;
  attempt: number;
  /** When THIS run began — not when the stage was entered. */
  startedAt: string;
  endedAt: string | null;
  /**
   * True when the previous run of this stage resolved its gates from a
   * different manifest revision (`manifest/gateRevision.ts`). A gate that FAILED
   * and was then deleted from `karst.yml` otherwise reads, on the next attempt,
   * as a stage that simply passed — the question was removed rather than
   * answered, and nothing recorded the difference.
   */
  gateSetChanged: boolean;
}

/** The completed ticket this one continues work from, or null for an ordinary ticket. */
export interface TicketContextParent {
  key: string | null;
  title: string | null;
  brief: string | null;
  prs: { repo: string; number: number | null; url: string | null }[];
}

/**
 * The OPEN ticket this one is PART OF (a sub-task, design NDL-70 §7), or null
 * for an ordinary ticket.
 *
 * Deliberately NOT `TicketContextParent`: a follow-up continues a SHIPPED ticket
 * and inherits its brief and PRs, while a sub-task is carved out of work still
 * in flight. So this carries the parent's own ask (`prompt`) and brief, and the
 * parent's branch per repo — the branch the sub-task's own branch is cut from
 * and lands into. The parent's PRs are deliberately absent: they record shipped
 * work, which a parent that is still open by definition does not have.
 */
export interface TicketContextSubtaskParent {
  key: string | null;
  title: string | null;
  /** The parent's authored ask (its `description` column). */
  prompt: string | null;
  brief: string | null;
  /** The parent's branch per repo, from its worktrees. Empty before the parent is cut. */
  branches: { repo: string; branch: string }[];
  /**
   * Whether THIS sub-task holds its own parent (its `blocks_parent` column) —
   * the child's half of the flag the parent's `subtasks[]` already reports
   * (NDL-96). Present here so a sub-task can answer "do I block my parent?"
   * from its own `context <key>` without resolving its parent id and re-reading
   * the parent's context.
   */
  blocksParent: boolean;
}

/** One direct sub-task of this ticket, as the parent's context lists it (design NDL-70 §7). */
export interface TicketContextSubtask {
  id: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  /** When this sub-task was paused, or null if active. */
  pausedAt: string | null;
  /** True when this sub-task holds the parent before it leaves `impl`/`fix`. */
  blocksParent: boolean;
  /** The raw auto-start queue flag (`autostart_pending`, v64). */
  autostartPending: boolean;
  /** Waiting to be auto-started: `autostartPending` while still at `scope`. */
  queued: boolean;
}

/** This ticket's mailbox, as a pointer: a count, never the bodies (untrusted). */
export interface TicketContextInbox {
  unread: number;
}

/** Unread project notes matching this ticket: a count and sanitized titles, never bodies. */
export interface TicketContextNotes {
  unread: number;
  titles: string[];
}

/** The host-written notes index: counts and titles from the store, never bodies. */
function ticketNotes(store: Store, ticketId: number): TicketContextNotes {
  const index = unreadNoteIndex(store, ticketId);
  return { unread: index.count, titles: index.titles };
}

/**
 * One repository in the ticket's scope, as the agent sees it.
 *
 * `repoPath` is absent when the name is not in the manifest at all — that used
 * to be dropped silently (`if (!def) continue`), which told the agent the repo
 * did not exist rather than that karst could not find it. `start`/`health` are
 * absent when the repository declares no service; the old shape typed `start` as
 * required and rendered the literal string "undefined" into the brief.
 */
export interface TicketContextRepo {
  name: string;
  repoPath?: string;
  start?: string;
  health?: string;
  /** The folder the service starts from, relative to the repository, when set. */
  cwd?: string;
  /** False when the repository declares no service. Stated, never inferred. */
  runnable: boolean;
  /** True when the selected name has no manifest entry. */
  unknown: boolean;
}

/** Everything a session needs about a ticket, JSON-serializable for the CLI. */
export interface TicketContext {
  /**
   * The ticket's row id — always present and always resolvable via
   * `karst context <id>` (the CLI accepts a bare numeric id, § resolveTicketByKey),
   * unlike `key` which can be empty. Used as the runnable fallback for any
   * stated truncation pointer when the ticket has no key.
   */
  id: number;
  key: string | null;
  title: string | null;
  /** The user's authored instruction (the `description` column). */
  prompt: string | null;
  brief: string | null;
  approach: string | null;
  agent: string | null;
  selectedRepos: string[];
  worktrees: TicketContextWorktree[];
  servers: TicketContextServer[];
  prs: TicketContextPr[];
  /** Images and video attached to the prompt. Empty when there are none. */
  attachments: TicketContextAttachment[];
  /** Set when this ticket was created via "create follow-up" from a completed parent. */
  parent: TicketContextParent | null;
  /** Set when this ticket is a sub-task (part of an open parent, design NDL-70 §7). */
  subtaskParent: TicketContextSubtaskParent | null;
  /** Direct sub-tasks of this ticket, when it has any (design NDL-70 §7). */
  subtasks: TicketContextSubtask[];
  /** Unread parent<->child mailbox rows; read them with `karst inbox`. */
  inbox: TicketContextInbox;
  /** Unread project notes that match this ticket; read them with `karst notes`. */
  notes: TicketContextNotes;
  /** Outcomes of this ticket's blockers that already landed (read-only). */
  blockers: BlockerOutcome[];
  repos: TicketContextRepo[];
  /**
   * The ticket's CURRENT stage key — the stage a session is actually sitting
   * at. Differs from `stage.stageKey` exactly at `fix`, where the stage section
   * shows the failed gate stage's evidence while the ticket waits at `fix`.
   */
  stageCurrent: string | null;
  /** Whether the task execution is currently paused. */
  paused: boolean;
  pausedAt: string | null;
  /** Read-only stage/gate/finding state (§ context loader, closes G15). Null only for a stage key not present on the ticket's own rows — should not happen in practice. */
  stage: TicketContextStage | null;
}

/** The gate stages — the only ones that record `gate_runs`/`review_findings` evidence. Mirrors `agent/fixBrief.ts`'s own `GATES`, kept local rather than a shared import so this leaf module (consumed by both the launch seed and the CLI) has no dependency on `workflow/`. */
const GATE_STAGES: readonly StageKey[] = ['uat', 'review'];

/**
 * The non-marker stages worth telling a session it cannot advance. `scope` and
 * `done` are left out on purpose — no agent session exists at the first, and
 * nothing follows the last, so the line would only be noise on a fresh or a
 * finished ticket.
 */
const ADVISORY_STAGES: readonly string[] = ['uat', 'review', 'ship'];

/**
 * The stage row whose gate/finding evidence a session actually wants.
 * Ordinarily the ticket's current stage; at `fix` (which records no gate
 * evidence of its own) this is the most recently FAILED gate stage instead —
 * the question a fix session needs answered is "what did I fail", not "what
 * `fix` itself reports", which is always empty.
 */
function relevantStageRow(t: TicketWithStages): TicketWithStages['stages'][number] | undefined {
  if (t.stageCurrent === 'fix') {
    const failedGate = t.stages.find(
      (s) => (GATE_STAGES as readonly string[]).includes(s.stageKey) && s.status === 'failed',
    );
    if (failedGate) return failedGate;
  }
  return t.stages.find((s) => s.stageKey === t.stageCurrent);
}

/**
 * The rows one selected repository contributes: one per runnable service (a
 * multi-service repository names each `repo/service`), or a single row that
 * states the repository has no service, or that it is missing from the manifest.
 */
function repoRows(name: string, def: RepositoryDef | undefined): TicketContextRepo[] {
  if (!def) return [{ name, runnable: false, unknown: true }];
  const units = unitsOf(name, def);
  if (units.length === 0) {
    return [{ name, repoPath: def.repoPath, runnable: false, unknown: false }];
  }
  return units.map((u) => ({
    name: u.key,
    repoPath: def.repoPath,
    runnable: true,
    unknown: false,
    start: u.def.start,
    ...(u.def.health !== undefined ? { health: u.def.health } : {}),
    ...(u.def.cwd !== undefined ? { cwd: u.def.cwd } : {}),
  }));
}

/**
 * Aggregate all ticket-implementation data by id. Pure over the injected store
 * and manifest — no fs, no vscode. `manifest` is optional (absent at some launch
 * paths) → every selected repo renders as unknown rather than vanishing.
 */
export function buildTicketContext(
  store: Store,
  manifest: Manifest | undefined,
  ticketId: number,
  /**
   * The global-storage root attachment paths are built from. Optional because
   * an absolute path cannot be formed without it: with no root, `attachments`
   * is empty and the section is omitted, rather than emitting a half-built path
   * the agent would fail to open with no way to tell why. Both real callers
   * supply it — the extension from `globalStorageUri`, the CLI from the DB
   * file's own directory.
   */
  storageDir?: string,
): TicketContext {
  const t = getTicket(store, ticketId);
  const mergeChecks = new Map(listMergeChecksByTicket(store, ticketId).map((c) => [c.repo, c]));

  const defs = manifest?.repositories ?? {};
  const repos: TicketContextRepo[] = t.selectedRepos.flatMap((name) =>
    repoRows(name, defs[name]),
  );

  // A follow-up carries its parent's brief and shipped PRs so the new session
  // starts from what was already learned instead of re-researching it
  // (§ continue work on a ticket).
  const parent: TicketContextParent | null = (() => {
    if (t.parentTicketId === null) return null;
    let p;
    try {
      p = getTicket(store, t.parentTicketId);
    } catch {
      return null; // parent was hard-deleted; degrade rather than fail context building
    }
    return {
      key: p.key,
      title: p.title,
      brief: p.brief,
      prs: listPrsByTicket(store, p.id).map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
      })),
    };
  })();

  // A sub-task is PART OF an open ticket (design NDL-70 §7). It gets the
  // parent's ask and branch so it knows whose work it extends and where its own
  // branch lands — but NOT the parent's PRs, which a still-open ticket has none
  // of (that inheritance belongs to follow-ups, above).
  const subtaskParent: TicketContextSubtaskParent | null = (() => {
    if (t.subtaskParentId === null) return null;
    let p;
    try {
      p = getTicket(store, t.subtaskParentId);
    } catch {
      return null; // parent hard-deleted; degrade rather than fail context building
    }
    return {
      key: p.key,
      title: p.title,
      prompt: p.description,
      brief: p.brief,
      branches: listWorktreesByTicket(store, p.id)
        .filter((w) => w.branch !== null && w.branch.trim() !== '')
        .map((w) => ({ repo: w.repo, branch: w.branch! })),
      blocksParent: t.blocksParent,
    };
  })();

  const subtasks: TicketContextSubtask[] = listSubtasks(store, ticketId).map((s) => ({
    id: s.id,
    key: s.key,
    title: s.title,
    stageCurrent: s.stageCurrent,
    pausedAt: s.pausedAt,
    blocksParent: s.blocksParent,
    autostartPending: s.autostartPending,
    queued: isQueuedSubtask({ ...s, subtaskParentId: ticketId }),
  }));

  const stageRow = relevantStageRow(t);
  const stageRun = stageRow ? latestStageRun(store, ticketId, stageRow.stageKey) : null;
  const priorRun = stageRun ? previousStageRun(store, stageRun) : null;
  const blockedRow =
    (stageRow?.blockedKind ? stageRow : undefined) ??
    t.stages.find((s) => s.blockedKind !== null);
  const stage: TicketContextStage | null = stageRow
    ? {
        stageKey: stageRow.stageKey,
        status: stageRow.status,
        verdict: stageRow.verdict,
        artifactPath: stageRow.artifactPath,
        // Whether the AGENT may advance the ticket at its CURRENT stage — the
        // marker is a property of the ticket, not of the evidence row rendered
        // here: at `fix` the section shows the failed gate stage, yet the fix
        // session's `stage fix pass` marker is the whole point of the session.
        agentCanAdvance:
          t.stageCurrent !== null && isMarkerStage(t.stageCurrent as StageKey),
        run: stageRun
          ? {
              status: stageRun.status,
              outcome: stageRun.outcome,
              attempt: stageRun.attempt,
              startedAt: stageRun.startedAt,
              endedAt: stageRun.endedAt,
              // Only a run that HAS a predecessor can differ from one, and only
              // two runs that both recorded a hash can be compared: a null on
              // either side is "unknown", never "changed".
              gateSetChanged:
                priorRun !== null &&
                stageRun.manifestHash !== null &&
                priorRun.manifestHash !== null &&
                stageRun.manifestHash !== priorRun.manifestHash,
            }
          : null,
        blocked: blockedRow?.blockedKind
          ? { kind: blockedRow.blockedKind, reason: blockedRow.blockedReason ?? '' }
          : null,
        gates: latestBatch(listGateRuns(store, ticketId), stageRow.stageKey).map((g) => ({
          name: g.gateName,
          exitCode: g.exitCode,
          skipped: g.skipped,
          summary: g.summary ?? null,
        })),
        // Findings are review-only evidence (Lane B writes nothing for uat).
        findings:
          stageRow.stageKey === 'review'
            ? latestFindingBatch(store, ticketId).map((f) => ({
                severity: f.severity,
                repo: f.repo,
                file: f.file,
                line: f.line,
                title: f.title,
                detail: f.detail,
              }))
            : [],
      }
    : null;

  return {
    id: ticketId,
    key: t.key,
    title: t.title,
    prompt: t.description,
    brief: t.brief,
    approach: t.approach,
    agent: t.agent,
    stageCurrent: t.stageCurrent,
    paused: t.pausedAt !== null,
    pausedAt: t.pausedAt,
    selectedRepos: t.selectedRepos,
    worktrees: listWorktreesByTicket(store, ticketId).map((w) => {
      let source: 'override' | 'parent' | 'manifest' | undefined;
      if (w.baseRef) {
        if (t.baseRefs?.[w.repo] && t.baseRefs[w.repo] === w.baseRef) {
          source = 'override';
        } else if (subtaskParent?.branches.some((b) => b.repo === w.repo && b.branch === w.baseRef)) {
          source = 'parent';
        } else {
          source = 'manifest';
        }
      }
      return {
        repo: w.repo,
        path: w.path,
        branch: w.branch,
        baseRef: w.baseRef,
        source,
        depsMode: w.depsMode,
      };
    }),
    servers: listServersByTicket(store, ticketId).map((s) => ({
      service: s.service,
      host: s.host,
      port: s.port,
      status: s.status,
    })),
    prs: listPrsByTicket(store, ticketId).map((p) => {
      const check = mergeChecks.get(p.repo);
      return {
        repo: p.repo,
        number: p.number,
        url: p.url,
        status: p.status,
        // Spread rather than `mergeCheck: undefined`, so a never-checked PR
        // serializes to the exact JSON the CLI emitted before this existed.
        ...(check
          ? { mergeCheck: { state: check.state, files: check.files, reason: check.reason } }
          : {}),
      };
    }),
    attachments:
      storageDir === undefined
        ? []
        : listAttachments(store, ticketId).map((a) => ({
            kind: a.kind,
            path: attachmentPath(storageDir, ticketId, a.storedName),
            name: a.originalName,
          })),
    parent,
    subtaskParent,
    subtasks,
    inbox: { unread: unreadCount(store, ticketId) },
    notes: ticketNotes(store, ticketId),
    blockers: landedBlockerOutcomes(store, ticketId),
    repos,
    stage,
  };
}

/**
 * Which sections a render emits.
 *
 * - `all` — every section (the CLI, the graph planner prompts, every
 *   pre-existing caller).
 * - `narrative` — the subset a HUMAN reads in a session transcript: the
 *   ticket's own authored prose, its attachments, its parent's/sub-tasks'
 *   summaries, and the inbox pointer. Every operational fact (stage, repos,
 *   worktrees, servers, PRs) is omitted because the session pulls those live
 *   via `karst context`.
 * - `facts` — the complement of `narrative`: ONLY the structured operational
 *   facts (current stage/gates/findings, repositories in scope, worktrees &
 *   branches, running servers, pull requests). The launch seed routes this half
 *   into the instruction layer, and the authored half into the kickoff.
 */
export type ContextSections = 'all' | 'narrative' | 'facts';

function ticketHeading(ctx: TicketContext): string {
  const key = ctx.key?.trim();
  const title = ctx.title?.trim();
  if (key && title) return `${key} — ${title}`;
  return key || title || 'Untitled ticket';
}

/**
 * Render a `TicketContext` to deterministic markdown. Only non-empty sections
 * are emitted, so a bare ticket yields just its heading rather than a wall of
 * empty headings (mirrors the prior seed behavior, now enriched with
 * worktrees/branches, repositories, and PRs).
 */
/** Stages whose session reads the plan or the code, where unread notes can change the work. */
const NOTE_REMINDER_STAGES: readonly string[] = ['scope', 'impl'];
const NOTE_REMINDER =
  'Read these before you start: unread notes may change your plan.';

/** The `## Project notes` index: titles only; bodies are read with `karst notes`. */
function renderNotesSection(ctx: TicketContext): string {
  const { unread, titles } = ctx.notes;
  const lines = [
    `## Project notes`,
    `${unread} unread project note${unread === 1 ? '' : 's'} match this ticket — run \`karst notes\` to read them.`,
    ...titles.slice(0, NOTE_INDEX_TITLE_MAX).map((title) => `- ${title}`),
  ];
  if (unread > titles.length) lines.push(`- … and ${unread - titles.length} more`);
  if (ctx.stageCurrent !== null && NOTE_REMINDER_STAGES.includes(ctx.stageCurrent)) {
    lines.push(NOTE_REMINDER);
  }
  return lines.join('\n');
}

export function renderTicketContext(
  ctx: TicketContext,
  debug?: (msg: string) => void,
  opts?: { bounded?: boolean; sections?: ContextSections; stageEnding?: string },
): string {
  const bounded = opts?.bounded ?? true;
  const sections = opts?.sections ?? 'all';
  // The two halves the launch seed routes independently: authored text rides the
  // kickoff, structured facts ride the instruction layer. `all` renders both.
  const authored = sections === 'all' || sections === 'narrative';
  const operational = sections === 'all' || sections === 'facts';
  const parts: string[] = authored ? [`# Ticket: ${ticketHeading(ctx)}`] : [];
  // A ticket's key can be empty (never blank the pointer's command target on
  // that account) — `id` is always present and `karst context <id>` resolves
  // a bare numeric id (§ resolveTicketByKey), so it is a genuinely runnable
  // fallback, unlike the placeholder string 'this ticket' would be.
  const key = ctx.key?.trim() || String(ctx.id);

  if (operational && ctx.stage) {
    const s = ctx.stage;
    const lines = [`- stage: ${s.stageKey} (${s.status})`];
    if (ctx.paused && ctx.pausedAt) {
      lines.push(`- paused since ${ctx.pausedAt} — gates do not run; resume: karst unpause ${key}`);
    }
    if (s.verdict) lines.push(`- verdict: ${s.verdict}`);
    if (s.blocked) lines.push(`- blocked: ${s.blocked.kind} — ${s.blocked.reason}`);
    if (s.run) {
      // The run's OWN clock and status. `- stage: review (running)` on its own
      // was the whole of what a session could see, and it could not distinguish
      // a stage that never started from one in flight from one whose host died
      // mid-run — the ambiguity that cost a session ~40 minutes of digging
      // through SQLite by hand.
      const ended = s.run.endedAt ? `, ended ${s.run.endedAt}` : '';
      const outcome = s.run.outcome ? ` → ${s.run.outcome}` : '';
      lines.push(
        `- gate run: ${s.run.status}${outcome} (attempt ${s.run.attempt}, started ${s.run.startedAt}${ended})`,
      );
      if (s.run.status === 'stale') {
        lines.push(
          '- note: the previous run of this stage was destroyed before it finished ' +
            '(its process is gone). Its gate rows below are partial; the stage will run again.',
        );
      }
      if (s.run.gateSetChanged) {
        lines.push(
          '- note: the gate set changed since the previous run — this attempt is not ' +
            'answering the same questions the last one asked.',
        );
      }
    }
    if (s.artifactPath) lines.push(`- log: ${s.artifactPath}`);
    if (s.gates.length > 0) {
      lines.push('- gates:');
      for (const g of s.gates) {
        const state = g.skipped
          ? 'skipped (disabled for this ticket)'
          : g.exitCode === null
            ? 'not run (no such script)'
            : `exit ${g.exitCode}`;
        lines.push(`  - ${g.name}: ${state}`);
        // v46: the failing gate's bounded output excerpt — the "what failed
        // (file, line, rule)" the verdict string cannot carry, surfaced so a
        // session never has to open the artifact log just to learn what broke.
        if (g.summary) {
          const summary = bounded
            ? (() => {
                const { text, truncated } = truncateToBudget(g.summary!, SEED_BUDGETS.gateSummary, key);
                if (truncated) debug?.(`[seed] truncated gate summary for ${g.name} to ${SEED_BUDGETS.gateSummary} chars`);
                return text;
              })()
            : g.summary;
          for (const line of summary.split('\n')) lines.push(`      ${line}`);
        }
      }
    }
    if (s.findings.length > 0) {
      const findingsBlock = s.findings
        .map((f) => {
          const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
          return `  - [${f.severity}] ${f.title}${loc}`;
        })
        .join('\n');
      const findingsText = bounded
        ? (() => {
            const { text, truncated } = truncateToBudget(findingsBlock, SEED_BUDGETS.findings, key);
            if (truncated) debug?.(`[seed] truncated findings list to ${SEED_BUDGETS.findings} chars`);
            return text;
          })()
        : findingsBlock;
      lines.push('- findings:', findingsText);
    }
    if (
      !s.agentCanAdvance &&
      ctx.stageCurrent !== null &&
      ADVISORY_STAGES.includes(ctx.stageCurrent)
    ) {
      // The seeded marker command names `impl`; fired at one of these it is
      // REFUSED, and the seed never said so — an agent that trusts it reports a
      // ticket advanced that has not moved. So the refusal is stated up front,
      // for the stages a live session can actually be sitting at. Driven by the
      // ticket's CURRENT stage, never the evidence row above: at `fix` the
      // section shows the failed gate stage, but the fix session's own marker
      // (`stage fix pass`) IS valid — telling it "nothing you run advances this
      // stage" would contradict the very instruction its seed carries.
      // `scope` and `done` are excluded deliberately: no session exists at the
      // first and nothing follows the last, so the line would be pure noise.
      const why = (GATE_STAGES as readonly string[]).includes(ctx.stageCurrent)
        ? `${GATE_DECIDED_BY_EXIT_CODES}`
        : 'karst advances it, not the agent';
      lines.push(
        `- note: \`${s.stageKey}\` is not an agent-advanced stage — ${why}, and the ` +
          `${MARKER_REFUSED} here. Nothing you run ` +
          'advances this stage.',
      );
    }
    parts.push(`## Current stage\n${lines.join('\n')}`);
  }

  if (operational && opts?.stageEnding) {
    parts.push(`## How this stage ends\n${opts.stageEnding}`);
  }

  // The work this ticket delegated to sub-tasks (design NDL-70 §7), so the
  // parent agent does not redo it. Rendered in every section mode for the same
  // reason as the parent section above.
  if (authored && ctx.subtasks.length > 0) {
    const rows = ctx.subtasks.map((s) => {
      const key = s.key?.trim() || `#${s.id}`;
      const title = s.title?.trim();
      const named = title ? `: ${title}` : '';
      const flag = s.blocksParent ? ' [blocking]' : '';
      const queued = s.queued ? ', queued' : '';
      const paused = s.pausedAt ? `, paused since ${s.pausedAt}` : '';
      return `- ${key}${named} (stage: ${s.stageCurrent ?? 'unknown'}${queued}${paused})${flag}`;
    });

    const total = ctx.subtasks.length;
    const pausedCount = ctx.subtasks.filter((s) => s.pausedAt !== null).length;
    const unpaused = ctx.subtasks.filter((s) => s.pausedAt === null);
    const stageOrder: readonly string[] = [...STAGE_KEYS].reverse();
    const partsList: string[] = [];
    for (const stage of stageOrder) {
      const count = unpaused.filter((s) => s.stageCurrent === stage).length;
      if (count > 0) partsList.push(`${count} ${stage}`);
    }
    const remaining = unpaused.filter((s) => !stageOrder.includes(s.stageCurrent ?? ''));
    if (remaining.length > 0) partsList.push(`${remaining.length} ${remaining[0]?.stageCurrent ?? 'unknown'}`);
    if (pausedCount > 0) partsList.push(`${pausedCount} paused`);

    const heading = partsList.length > 0
      ? `## Sub-tasks (${total}: ${partsList.join(', ')})`
      : `## Sub-tasks (${total})`;

    parts.push(
      `${heading}\nThis ticket's work is delegated to the following sub-tasks — do not redo them.\n${rows.join('\n')}`,
    );
  }

  if (operational && ctx.prs.length > 0) {
    const rows = ctx.prs.map((p) => {
      const num = p.number !== null ? `#${p.number}` : '(no number)';
      const url = p.url ? ` — ${p.url}` : '';
      const status = p.status ? ` [${p.status}]` : '';
      // Suffixed on the existing line rather than given a section of its own: an
      // agent already reads this list, and mergeability is a fact ABOUT the PR.
      const merge = p.mergeCheck ? ` · merge: ${summarizeMergeCheck(p.mergeCheck)}` : '';
      return `- ${p.repo} ${num}${status}${url}${merge}`;
    });
    parts.push(`## Pull requests\n${rows.join('\n')}`);
  }

  // One section, not two. The old render emitted a bare name list AND a richer
  // "## Services" list, so a repository appeared twice and a non-runnable one
  // appeared in the first with no hint it would never start.
  if (operational && ctx.repos.length > 0) {
    const rows = ctx.repos.map((r) => {
      if (r.unknown) return `- ${r.name}: (not in karst.yml)`;
      if (!r.start) return `- ${r.name}: ${r.repoPath} (no service — not runnable)`;
      const cwd = r.cwd !== undefined ? `, cwd: ${r.cwd}` : '';
      const health = r.health ? `, health: ${r.health}` : '';
      return `- ${r.name}: ${r.repoPath} (start: \`${r.start}\`${cwd}${health})`;
    });
    parts.push(`## Repositories in scope\n${rows.join('\n')}`);
  }

  if (operational && ctx.worktrees.length > 0) {
    const rows = ctx.worktrees.map((w) => {
      const branch = w.branch ?? '(no branch)';
      const sourceTag = w.source ? `, ${w.source}` : '';
      const base = w.baseRef ? ` (from ${w.baseRef}${sourceTag})` : '';
      return `- ${w.repo}: \`${branch}\`${base} — ${w.path}`;
    });
    parts.push(`## Worktrees & branches\n${rows.join('\n')}`);
  }

  if (operational && ctx.servers.length > 0) {
    const rows = ctx.servers.map(
      (s) => `- ${s.service}: ${s.host ?? '?'}:${s.port ?? '?'} (${s.status})`,
    );
    parts.push(`## Running servers\n${rows.join('\n')}`);
  }

  // The mailbox is a pointer only: bodies are untrusted agent prose and are
  // framed by `karst inbox`, never inlined into a seed.
  if (authored && ctx.inbox.unread > 0) {
    const n = ctx.inbox.unread;
    parts.push(
      `## Inbox\n${n} unread message${n === 1 ? '' : 's'} — run \`karst inbox\` to read them.`,
    );
  }

  if (authored && ctx.notes.unread > 0) {
    parts.push(renderNotesSection(ctx));
  }

  // What the blockers that already landed delivered. Bounded per blocker (the
  // mailbox cap) and quoted by the renderer; the rest is one `karst context` away.
  if (authored && ctx.blockers.length > 0) {
    const rows = ctx.blockers.map((b) => renderBlockerOutcome(b));
    parts.push(`## Blockers\nThese blockers landed before you started.\n\n${rows.join('\n\n---\n\n')}`);
  }

  const promptRaw = authored ? ctx.prompt?.trim() : undefined;
  if (promptRaw) {
    const prompt = bounded
      ? (() => {
          const { text, truncated } = truncateToBudget(promptRaw, SEED_BUDGETS.ticketPrompt, key);
          if (truncated) debug?.(`[seed] truncated ticket prompt to ${SEED_BUDGETS.ticketPrompt} chars`);
          return text;
        })()
      : promptRaw;
    parts.push(`## Prompt\n${prompt}`);
  }

  const briefRaw = authored ? ctx.brief?.trim() : undefined;
  if (briefRaw && briefRaw !== promptRaw) {
    const brief = bounded
      ? (() => {
          const { text, truncated } = truncateToBudget(briefRaw, SEED_BUDGETS.brief, key);
          if (truncated) debug?.(`[seed] truncated context brief to ${SEED_BUDGETS.brief} chars`);
          return text;
        })()
      : briefRaw;
    parts.push(`## Context brief\n${brief}`);
  }

  if (authored && ctx.attachments.length > 0) {
    const rowsBlock = ctx.attachments
      .map((a) => {
        // Video is stated as unreadable rather than omitted. Omitting it would let
        // an agent conclude nothing was attached; listing it bare would let one
        // report on footage it never opened.
        const note = a.kind === 'video' ? ' (not agent-readable)' : '';
        return `- ${a.kind}: ${a.path} — "${a.name}"${note}`;
      })
      .join('\n');
    const attachmentsText = bounded
      ? (() => {
          const { text, truncated } = truncateToBudget(rowsBlock, SEED_BUDGETS.attachments, key);
          if (truncated) debug?.(`[seed] truncated attachments list to ${SEED_BUDGETS.attachments} chars`);
          return text;
        })()
      : rowsBlock;
    parts.push(`## Attachments\n${attachmentsText}`);
  }

  if (authored && ctx.parent) {
    const heading =
      ctx.parent.key && ctx.parent.title
        ? `${ctx.parent.key}: ${ctx.parent.title}`
        : ctx.parent.key || ctx.parent.title || 'parent ticket';
    const lines: string[] = [];
    const parentBrief = ctx.parent.brief?.trim();
    if (parentBrief) lines.push(parentBrief);
    for (const pr of ctx.parent.prs) {
      const num = pr.number !== null ? `#${pr.number}` : '(no number)';
      const url = pr.url ? ` — ${pr.url}` : '';
      lines.push(`- ${pr.repo} ${num}${url}`);
    }
    parts.push(`## Continuing from ${heading}\n${lines.join('\n')}`);
  }

  // A sub-task's parent (design NDL-70 §7). Rendered in every section mode: a
  // session must know where its branch lands (into the parent's branch or its
  // chosen base) whether it reads the seed or re-pulls `karst context`. The parent's PRs are
  // deliberately not rendered (that is the follow-up section's job).
  if (authored && ctx.subtaskParent) {
    const p = ctx.subtaskParent;
    const base =
      p.key && p.title
        ? `${p.key}: ${p.title}`
        : p.key || p.title || 'the parent ticket';
    // The child's own blocking status, legible without a parent round-trip
    // (NDL-96) — the same tag the parent's Sub-tasks section prints per child.
    const heading = p.blocksParent ? `${base} [blocking]` : base;
    const lines: string[] = [
      `This ticket is a sub-task of ${heading} — its work is part of that open ticket, not standalone.`,
    ];
    if (p.blocksParent) {
      lines.push(
        'This sub-task blocks its parent: the parent waits on it before it can leave impl/fix.',
      );
    }
    const parentAsk = p.prompt?.trim();
    if (parentAsk) lines.push(parentAsk);
    const parentBrief = p.brief?.trim();
    if (parentBrief) lines.push(parentBrief);
    for (const b of p.branches) lines.push(`- ${b.repo}: \`${b.branch}\``);

    // Landing instruction: check if this sub-task is non-stacked.
    const parentBranches = new Map(p.branches.map((b) => [b.repo, b.branch]));
    const nonStacked = ctx.worktrees.filter(
      (w) => w.baseRef && parentBranches.has(w.repo) && w.baseRef !== parentBranches.get(w.repo),
    );
    if (nonStacked.length > 0) {
      const targets = nonStacked.map((w) => `\`${w.baseRef}\``).join(', ');
      lines.push(
        `Your branch lands into ${targets}, not into the parent's branch — open your PR against ${targets}.`,
      );
    } else {
      lines.push(
        "Your branch lands into the parent's branch, not into main — open your PR against " +
          "the parent's branch, and expect it to stack on the parent's work.",
      );
    }
    parts.push(`## Parent task\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}


