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

import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import {
  listWorktreesByTicket,
  listServersByTicket,
  listPrsByTicket,
} from '../store/dashboard.js';
import { listMergeChecksByTicket } from '../store/mergeChecks.js';
import { summarizeMergeCheck, type MergeCheckView } from '../model/mergeCheckView.js';
import type { Manifest } from '../manifest/types.js';

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

export interface TicketContextService {
  name: string;
  repoPath: string;
  start: string;
  health?: string;
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
  services: TicketContextService[];
}

/**
 * Aggregate all ticket-implementation data by id. Pure over the injected store
 * and manifest — no fs, no vscode. `manifest` is optional (absent at some launch
 * paths) → the services section is simply empty.
 */
export function buildTicketContext(
  store: Store,
  manifest: Manifest | undefined,
  ticketId: number,
): TicketContext {
  const t = getTicket(store, ticketId);
  const mergeChecks = new Map(listMergeChecksByTicket(store, ticketId).map((c) => [c.repo, c]));

  const services: TicketContextService[] = [];
  const defs = manifest?.services ?? {};
  for (const name of t.selectedRepos) {
    const def = defs[name];
    if (!def) continue;
    services.push({
      name,
      repoPath: def.repoPath,
      start: def.start,
      ...(def.health !== undefined ? { health: def.health } : {}),
    });
  }

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
    services,
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
 * worktrees/branches, services, and PRs).
 */
export function renderTicketContext(ctx: TicketContext): string {
  const parts: string[] = [`# Ticket: ${ticketHeading(ctx)}`];

  const prompt = ctx.prompt?.trim();
  if (prompt) parts.push(`## Prompt\n${prompt}`);

  const brief = ctx.brief?.trim();
  if (brief) parts.push(`## Context brief\n${brief}`);

  if (ctx.selectedRepos.length > 0) {
    parts.push(`## Repositories in scope\n${ctx.selectedRepos.map((r) => `- ${r}`).join('\n')}`);
  }

  if (ctx.worktrees.length > 0) {
    const rows = ctx.worktrees.map((w) => {
      const branch = w.branch ?? '(no branch)';
      const base = w.baseRef ? ` (from ${w.baseRef})` : '';
      return `- ${w.repo}: \`${branch}\`${base} — ${w.path}`;
    });
    parts.push(`## Worktrees & branches\n${rows.join('\n')}`);
  }

  if (ctx.services.length > 0) {
    const rows = ctx.services.map((s) => {
      const health = s.health ? `, health: ${s.health}` : '';
      return `- ${s.name}: ${s.repoPath} (start: \`${s.start}\`${health})`;
    });
    parts.push(`## Services\n${rows.join('\n')}`);
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

  return parts.join('\n\n');
}
