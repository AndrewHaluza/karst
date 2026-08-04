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

import type { AttachmentKind } from '../attachments/kinds.js';
import { attachmentPath } from '../attachments/paths.js';
import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import type { Severity } from '../manifest/types.js';
import { listAttachments } from '../store/attachments.js';
import { getTicket, type TicketWithStages } from '../store/tickets.js';
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
import type { Manifest } from '../manifest/types.js';
import { isRunnable } from '../manifest/runnable.js';

export interface TicketContextWorktree {
  repo: string;
  path: string;
  branch: string | null;
  baseRef: string | null;
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
}

/** The completed ticket this one continues work from, or null for an ordinary ticket. */
export interface TicketContextParent {
  key: string | null;
  title: string | null;
  brief: string | null;
  prs: { repo: string; number: number | null; url: string | null }[];
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
  /** False when the repository declares no service. Stated, never inferred. */
  runnable: boolean;
  /** True when the selected name has no manifest entry. */
  unknown: boolean;
}

/** Everything a session needs about a ticket, JSON-serializable for the CLI. */
export interface TicketContext {
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
  repos: TicketContextRepo[];
  /** Read-only stage/gate/finding state (§ context loader, closes G15). Null only for a stage key not present on the ticket's own rows — should not happen in practice. */
  stage: TicketContextStage | null;
}

/** The gate stages — the only ones that record `gate_runs`/`review_findings` evidence. Mirrors `agent/fixBrief.ts`'s own `GATES`, kept local rather than a shared import so this leaf module (consumed by both the launch seed and the CLI) has no dependency on `workflow/`. */
const GATE_STAGES: readonly StageKey[] = ['uat', 'review'];

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
  const repos: TicketContextRepo[] = t.selectedRepos.map((name) => {
    const def = defs[name];
    if (!def) return { name, runnable: false, unknown: true };
    const service = isRunnable(def) ? def.service : undefined;
    return {
      name,
      repoPath: def.repoPath,
      runnable: service !== undefined,
      unknown: false,
      ...(service ? { start: service.start } : {}),
      ...(service?.health !== undefined ? { health: service.health } : {}),
    };
  });

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

  const stageRow = relevantStageRow(t);
  const stage: TicketContextStage | null = stageRow
    ? {
        stageKey: stageRow.stageKey,
        status: stageRow.status,
        verdict: stageRow.verdict,
        blocked: stageRow.blockedKind
          ? { kind: stageRow.blockedKind, reason: stageRow.blockedReason ?? '' }
          : null,
        gates: latestBatch(listGateRuns(store, ticketId), stageRow.stageKey).map((g) => ({
          name: g.gateName,
          exitCode: g.exitCode,
          skipped: g.skipped,
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
    key: t.key,
    title: t.title,
    prompt: t.description,
    brief: t.brief,
    approach: t.approach,
    agent: t.agent,
    selectedRepos: t.selectedRepos,
    worktrees: listWorktreesByTicket(store, ticketId).map((w) => ({
      repo: w.repo,
      path: w.path,
      branch: w.branch,
      baseRef: w.baseRef,
      depsMode: w.depsMode,
    })),
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
    repos,
    stage,
  };
}

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
export function renderTicketContext(ctx: TicketContext): string {
  const parts: string[] = [`# Ticket: ${ticketHeading(ctx)}`];

  const prompt = ctx.prompt?.trim();
  if (prompt) parts.push(`## Prompt\n${prompt}`);

  const brief = ctx.brief?.trim();
  if (brief) parts.push(`## Context brief\n${brief}`);

  if (ctx.stage) {
    const s = ctx.stage;
    const lines = [`- stage: ${s.stageKey} (${s.status})`];
    if (s.verdict) lines.push(`- verdict: ${s.verdict}`);
    if (s.blocked) lines.push(`- blocked: ${s.blocked.kind} — ${s.blocked.reason}`);
    if (s.gates.length > 0) {
      lines.push(
        '- gates:',
        ...s.gates.map((g) => {
          const state = g.skipped
            ? 'skipped (disabled for this ticket)'
            : g.exitCode === null
              ? 'not run (no such script)'
              : `exit ${g.exitCode}`;
          return `  - ${g.name}: ${state}`;
        }),
      );
    }
    if (s.findings.length > 0) {
      lines.push(
        '- findings:',
        ...s.findings.map((f) => {
          const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
          return `  - [${f.severity}] ${f.title}${loc}`;
        }),
      );
    }
    parts.push(`## Current stage\n${lines.join('\n')}`);
  }

  if (ctx.attachments.length > 0) {
    const rows = ctx.attachments.map((a) => {
      // Video is stated as unreadable rather than omitted. Omitting it would let
      // an agent conclude nothing was attached; listing it bare would let one
      // report on footage it never opened.
      const note = a.kind === 'video' ? ' (not agent-readable)' : '';
      return `- ${a.kind}: ${a.path} — "${a.name}"${note}`;
    });
    parts.push(`## Attachments\n${rows.join('\n')}`);
  }

  // One section, not two. The old render emitted a bare name list AND a richer
  // "## Services" list, so a repository appeared twice and a non-runnable one
  // appeared in the first with no hint it would never start.
  if (ctx.repos.length > 0) {
    const rows = ctx.repos.map((r) => {
      if (r.unknown) return `- ${r.name}: (not in karst.yml)`;
      if (!r.start) return `- ${r.name}: ${r.repoPath} (no service — not runnable)`;
      const health = r.health ? `, health: ${r.health}` : '';
      return `- ${r.name}: ${r.repoPath} (start: \`${r.start}\`${health})`;
    });
    parts.push(`## Repositories in scope\n${rows.join('\n')}`);
  }

  if (ctx.worktrees.length > 0) {
    const rows = ctx.worktrees.map((w) => {
      const branch = w.branch ?? '(no branch)';
      const base = w.baseRef ? ` (from ${w.baseRef})` : '';
      return `- ${w.repo}: \`${branch}\`${base} — ${w.path}`;
    });
    parts.push(`## Worktrees & branches\n${rows.join('\n')}`);
  }

  if (ctx.servers.length > 0) {
    const rows = ctx.servers.map(
      (s) => `- ${s.service}: ${s.host ?? '?'}:${s.port ?? '?'} (${s.status})`,
    );
    parts.push(`## Running servers\n${rows.join('\n')}`);
  }

  if (ctx.prs.length > 0) {
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

  if (ctx.parent) {
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

  return parts.join('\n\n');
}
