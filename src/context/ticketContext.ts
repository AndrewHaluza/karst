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
import { listAttachments } from '../store/attachments.js';
import { getTicket } from '../store/tickets.js';
import {
  listWorktreesByTicket,
  listServersByTicket,
  listPrsByTicket,
} from '../store/dashboard.js';
import { listMergeChecksByTicket } from '../store/mergeChecks.js';
import { summarizeMergeCheck, type MergeCheckView } from '../model/mergeCheckView.js';
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
