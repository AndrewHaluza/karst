import { getTicket } from '../store/tickets.js';
import { probeMergedNothingNew } from './mergedNothingNew.js';
import type { GhRunner } from '../integrations/github.js';
import { listWorktreesByTicket, type WorktreeView } from '../store/dashboard.js';
import type { Store } from '../store/db.js';
import type { AgentProvider, ArtifactConventions, Manifest } from '../manifest/types.js';
import { resolvePresetDefaults } from '../agent/agentPresets.js';
import { nowIso } from '../model/time.js';
import {
  changedPathsMatching,
  dirtyPathsMatching,
  headCommit,
  parsePorcelainEntries,
  type GitRunner,
  type PorcelainEntry,
} from '../integrations/git.js';
import { renderArtifactTemplate, type ArtifactTemplateContext } from './artifactConventions.js';
import { resolveTicketBaseRef } from './baseRef.js';
import {
  resolveRepoConventions,
  resolveRepoName,
  resolveRepoScope,
  resolveTicketType,
} from './conventionContext.js';
import { scanPorcelainForDenied } from './shipDenyScan.js';
import { findExistingLivePr, findLatestImplRun, hasCompletedShipRun } from './stages/shipStore.js';

/**
 * Advisory preview of what ship's sweep commit and PR will do, computed
 * read-only while the header's ship slot is `confirm`/`retry`.
 *
 * It MUST NOT diverge from ship: the titles come from the same
 * `resolveShipArtifacts` ship calls, the deny scan is the same
 * `scanPorcelainForDenied`, and the excluded set is git's own answer to the SAME
 * `:(glob)` pathspecs `prepareCommitInQuarantine` resets. A preview that wrote a
 * quarantine, touched the index or opened an object would be a second source of
 * truth; this one reads only (`git status`, `git diff --name-only`) and renders.
 */

/** What a repo's sweep commit will do, as the preview frames it. */
export type ShipPreviewRepoStatus =
  /** The sweep commit carries at least one dirty path. */
  | 'will-commit'
  /** The sweep commit carries nothing (the agent already committed, or no change). */
  | 'nothing-to-commit'
  /** A live PR already exists for this repo; ship would skip it. */
  | 'already-shipped'
  /** The repo's current PR merged and the branch adds nothing; ship would skip it. */
  | 'already-merged'
  /** The repo's deny scan refuses it; ship would park the repo. */
  | 'blocked';

/** One repository's previewed ship facts. All strings are untrusted prose (UI-R32). */
export interface ShipPreviewRepo {
  /** The manifest repository NAME (`{repo}`), never the worktree's local path. */
  repo: string;
  /** The PR title ship would open with, rendered from the repo's conventions. */
  prTitle: string;
  /** The commit subject ship's sweep commit would use. */
  commitMessage: string;
  /** Dirty paths (`-uall`) the sweep commit carries once excludes are removed. */
  commitFiles: string[];
  /** Dirty paths kept out by `ship.exclude` (`arch:SHIP-EXCLUDE`). */
  excludedFiles: string[];
  /** Excluded pathspecs that also match already-committed changes (warning only). */
  committedExcludedWarning: string[];
  /** Paths the deny scan would refuse (`arch:SHIP-SECRET`) — the repo will be blocked. */
  deny: string[];
  /**
   * The live PR's number when one is open for the repo — `already-shipped`
   * (ship skips it) or a re-ship that commits and pushes into it; null
   * otherwise.
   */
  prNumber: number | null;
  /**
   * Whether the branch holds an effective change from its base, so a
   * `nothing-to-commit` repo can still be one that ships committed work.
   * Derived locally (no fetch); the webview uses it only for the
   * "every repo unchanged" warning (`arch:SHIP-UNCHANGED`).
   */
  changedFromBase: boolean;
  status: ShipPreviewRepoStatus;
  /** Per-repo read failure; the preview never blocks ship. Absent on success. */
  error?: string;
}

/** The host-derived preview on the dashboard state; `computedAt` stamps the read. */
export interface ShipPreview {
  computedAt: string;
  repos: ShipPreviewRepo[];
}

/** The ticket facts the artifact templates interpolate. */
export interface ShipArtifactTicket {
  type: string | null;
  model: string | null;
  agentProvider?: AgentProvider | null;
  agentPreset?: string | null;
  sessionProvider?: AgentProvider | null;
  approach?: string | null;
  sessionId?: string | null;
}

export interface ShipArtifactInput {
  manifest?: Manifest;
  ticketId: number;
  key: string;
  title: string;
  repoName: string;
  ticket: ShipArtifactTicket;
  /** Direct injection (focused tests); otherwise resolves per-repo conventions. */
  conventions?: ArtifactConventions;
  /**
   * The latest impl-stage process run for this ticket, if any (`provider`, `model`).
   * When present, its non-empty `provider` and `model` outrank the ticket/manifest defaults.
   */
  implRun?: {
    provider?: string | null;
    model?: string | null;
  } | null;
}

/** What ship renders for one repository: both subjects, its excludes and the context. */
export interface ShipArtifacts {
  commitMessage: string;
  prTitle: string;
  /** `repos.<name>.ship.exclude`, verbatim (empty when unset). */
  excludes: string[];
  /** The ArtifactTemplateContext both subjects and the PR body render from. */
  context: ArtifactTemplateContext;
}

/**
 * The `{model}` value for the PR description template, following the launch
 * precedence: the per-ticket model override, else the manifest-level default,
 * else nothing (the agent CLI picks its own default — rendered as `n/a` by the
 * default template). Blank at either level counts as "inherit".
 *
 * The manifest-level default is PRESET-AWARE: the effective preset supplies it
 * only when the ticket's own core is the preset's core (a preset is a
 * core+model pair), and the legacy `defaultModel` covers every other case.
 */
export function resolveTemplateModel(
  ticket: {
    model: string | null;
    agentProvider?: AgentProvider | null;
    agentPreset?: string | null;
  },
  manifest?: Manifest,
  implRun?: {
    model?: string | null;
  } | null,
): string | undefined {
  const defaults = manifest
    ? resolvePresetDefaults(manifest, 'implementation', {
        ticketPreset: ticket.agentPreset ?? null,
        explicitProvider: ticket.agentProvider ?? null,
      })
    : undefined;
  for (const candidate of [implRun?.model, ticket.model, defaults?.model ?? manifest?.defaultModel]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/**
 * Render the commit subject and PR title ship would use for ONE repository,
 * with the SAME template context and per-repo conventions (`D141`)
 * `driveTicket`/ship use. Ship and the preview call this one helper, so the two
 * can never disagree about what a title renders to.
 */
export function resolveShipArtifacts(input: ShipArtifactInput): ShipArtifacts {
  const conventions =
    input.conventions ?? resolveRepoConventions(input.manifest, input.repoName);
  const implProvider =
    typeof input.implRun?.provider === 'string' && input.implRun.provider.trim() !== ''
      ? input.implRun.provider.trim()
      : undefined;
  const context: ArtifactTemplateContext = {
    id: input.ticketId,
    key: input.key,
    title: input.title,
    repo: input.repoName,
    type: resolveTicketType(input.ticket, conventions),
    scope: resolveRepoScope(input.manifest, input.repoName),
    provider:
      implProvider ??
      input.ticket.sessionProvider ??
      input.ticket.agentProvider ??
      input.manifest?.agentProvider ??
      'claude',
    model: resolveTemplateModel(input.ticket, input.manifest, input.implRun),
    approach: input.ticket.approach ?? undefined,
    sessionId: input.ticket.sessionId ?? undefined,
  };
  const commitMessage = conventions?.commitMessage
    ? renderArtifactTemplate('commitMessage', conventions.commitMessage, context)
    : input.title;
  const prTitle = conventions?.pullRequestTitle
    ? renderArtifactTemplate('pullRequestTitle', conventions.pullRequestTitle, context)
    : input.title;
  const excludes = input.manifest?.repositories[input.repoName]?.ship?.exclude ?? [];
  return { commitMessage, prTitle, excludes, context };
}

/**
 * Split the porcelain dirty entries by the paths ship's exclude kept out,
 * mirroring the QUARANTINE reset `prepareCommitInQuarantine` performs. Order
 * follows the dirty list (git's own order), so the two lists read as one set.
 *
 * The reset restores each EXCLUDED path to `preHead`, but `git add -A` staged
 * a rename as a delete of the source AND an add of the destination: excluding
 * only the destination leaves the source deletion in the index, and the sweep
 * commit DELETES the source (`arch:SHIP-EXCLUDE`). So a rename whose
 * destination is excluded commits its source unless the source is excluded too
 * (both sides reset → nothing). Every other excluded entry commits nothing.
 */
export function partitionPorcelainByExclude(
  entries: readonly PorcelainEntry[],
  excluded: readonly string[],
): { commitFiles: string[]; excludedFiles: string[] } {
  const excludedSet = new Set(excluded);
  const commitFiles: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    commitFiles.push(path);
  };
  for (const entry of entries) {
    if (entry.from !== undefined && excludedSet.has(entry.path)) {
      if (!excludedSet.has(entry.from)) push(entry.from);
    } else if (!excludedSet.has(entry.path)) {
      push(entry.path);
    }
  }
  return { commitFiles, excludedFiles: [...excludedSet] };
}

/** Load the preview for one ticket (the dashboard panel's injected seam). */
export type ShipPreviewLoader = (
  ticketId: number,
  signal?: AbortSignal,
) => Promise<ShipPreview>;

interface RepoContext {
  store: Store;
  manifest: Manifest | undefined;
  git: GitRunner;
  /** Re-probes a merged PR's head; without it a merged repo previews as before. */
  gh?: GhRunner;
  ticketId: number;
  key: string;
  title: string;
  ticket: ShipArtifactTicket;
  /**
   * Latest impl-stage process run for this ticket, if any (`{provider, model}`).
   * When omitted, loaded from `store`.
   */
  implRun?: { provider?: string | null; model?: string | null } | null;
  signal?: AbortSignal;
}

/**
 * Whether the branch holds an effective change from its base, read LOCALLY (no
 * fetch — the preview repaints on demand and must not spend a network round
 * trip per repo). `origin/<base>` is preferred, then the local base; an
 * unresolvable base reads as changed so the all-unchanged warning is never a
 * false alarm.
 */
async function hasLocalChangesFrom(
  ctx: RepoContext,
  wt: WorktreeView,
  base: string,
): Promise<boolean> {
  const git = ctx.git;
  const opts = ctx.signal ? { signal: ctx.signal } : undefined;
  const candidates: string[] = [];
  const origin = await git(['rev-parse', '--verify', `origin/${base}^{commit}`], wt.path, opts);
  if (origin.exitCode === 0) candidates.push(`origin/${base}`);
  const local = await git(['rev-parse', '--verify', `${base}^{commit}`], wt.path, opts);
  if (local.exitCode === 0) candidates.push(base);
  if (candidates.length === 0) return true;
  const head = wt.branch && wt.branch.trim() !== '' ? wt.branch : 'HEAD';
  for (const spec of candidates) {
    const diff = await git(['diff', '--quiet', `${spec}...${head}`], wt.path, opts);
    if (diff.exitCode === 0) continue;
    // Exit 1 is a real difference; any higher exit is a git failure, and
    // assuming changes keeps the warning off rather than raising a false one.
    if (diff.exitCode === 1) return true;
    return true;
  }
  return false;
}

async function loadRepo(ctx: RepoContext, wt: WorktreeView): Promise<ShipPreviewRepo> {
  const { store, manifest, git, signal } = ctx;
  const opts = signal ? { signal } : undefined;
  const repoName = resolveRepoName(manifest, wt.repo);
  const base: ShipPreviewRepo = {
    repo: repoName,
    prTitle: '',
    commitMessage: '',
    commitFiles: [],
    excludedFiles: [],
    committedExcludedWarning: [],
    deny: [],
    prNumber: null,
    changedFromBase: false,
    status: 'nothing-to-commit',
  };
  try {
    // The SAME renderer ship calls; a malformed template is a per-repo error,
    // never a rejected whole-preview promise (the preview is advisory).
    const artifacts = resolveShipArtifacts({
      manifest,
      ticketId: ctx.ticketId,
      key: ctx.key,
      title: ctx.title,
      repoName,
      ticket: ctx.ticket,
      implRun: ctx.implRun,
    });
    base.prTitle = artifacts.prTitle;
    base.commitMessage = artifacts.commitMessage;

    // A live PR is only SKIPPED when this is not a re-ship. A ticket that has
    // already COMPLETED a ship (a `passed` run) and is back at ship delivers its
    // new work into the still-open PR (`FIX-46`): `runShipSaga` sets
    // `deliverToOpenPr` from the same `hasCompletedShipRun`, so ship commits and
    // pushes. Mirroring that here is what keeps the preview from claiming
    // "skipped" while ship commits the new work.
    const live = findExistingLivePr(store, ctx.ticketId, wt.repo);
    const deliversToOpenPr = live !== undefined && hasCompletedShipRun(store, ctx.ticketId);
    if (live && !deliversToOpenPr) {
      base.status = 'already-shipped';
      base.prNumber = live.number;
      return base;
    }
    if (live) base.prNumber = live.number;

    // Mirrors ship: a merged current PR with nothing new on the branch is not
    // shipped again. A dirty worktree is new work, so it is checked first.
    if (!live && ctx.gh) {
      const dirty = await git(['status', '--porcelain'], wt.path, opts);
      if (dirty.exitCode === 0 && dirty.stdout.trim() === '') {
        const landed = await probeMergedNothingNew(
          { store, git, gh: ctx.gh },
          ctx.ticketId,
          wt.repo,
          wt.path,
          { branch: wt.branch, baseRef: wt.baseRef },
        );
        if (landed) {
          base.status = 'already-merged';
          base.prNumber = landed.number;
          return base;
        }
      }
    }

    const status = await git(['status', '--porcelain', '-uall'], wt.path, opts);
    if (status.exitCode !== 0) {
      throw new Error(status.stderr.trim() || `git status exited ${status.exitCode}`);
    }
    base.deny = scanPorcelainForDenied(status.stdout).map((hit) => hit.path);
    const entries = parsePorcelainEntries(status.stdout);
    const specs = artifacts.excludes;
    const excluded = specs.length > 0 ? await dirtyPathsMatching(git, wt.path, specs) : [];
    const { commitFiles, excludedFiles } = partitionPorcelainByExclude(entries, excluded);
    base.commitFiles = commitFiles;
    base.excludedFiles = excludedFiles;
    if (base.deny.length > 0) {
      base.status = 'blocked';
    } else if (commitFiles.length > 0) {
      base.status = 'will-commit';
      base.changedFromBase = true;
    } else {
      base.status = 'nothing-to-commit';
    }

    const baseRef = manifest
      ? resolveTicketBaseRef(store, ctx.ticketId, wt.repo, manifest)
      : (wt.baseRef ?? '');
    if (specs.length > 0) {
      const head = await headCommit(git, wt.path);
      if (head !== null && baseRef) {
        base.committedExcludedWarning = await changedPathsMatching(
          git,
          wt.path,
          `${baseRef}...${head}`,
          specs,
        ).catch(() => [] as string[]);
      }
    }
    if (base.status === 'nothing-to-commit' && baseRef) {
      base.changedFromBase = await hasLocalChangesFrom(ctx, wt, baseRef);
    }
  } catch (error) {
    base.status = 'nothing-to-commit';
    base.error = error instanceof Error ? error.message : String(error);
  }
  return base;
}

/** Read the advisory ship preview for a ticket, one repo at a time, fail-soft. */
export async function loadShipPreview(ctx: RepoContext): Promise<ShipPreview> {
  const implRun =
    ctx.implRun !== undefined ? ctx.implRun : findLatestImplRun(ctx.store, ctx.ticketId);
  const repoCtx: RepoContext = ctx.implRun !== undefined ? ctx : { ...ctx, implRun };
  const worktrees = listWorktreesByTicket(ctx.store, ctx.ticketId);
  const repos = await Promise.all(worktrees.map((wt) => loadRepo(repoCtx, wt)));
  return { computedAt: nowIso(), repos };
}

/** Build the loader the dashboard panel consumes, bound to one store + git. */
export function makeShipPreviewLoader(
  store: Store,
  manifest: () => Manifest | undefined,
  git: GitRunner,
  gh?: GhRunner,
): ShipPreviewLoader {
  return async (ticketId, signal) => {
    const ticket = getTicket(store, ticketId);
    const title = ticket.title ?? ticket.key ?? `Ticket ${ticketId}`;
    const key = ticket.key ?? String(ticketId);
    return loadShipPreview({
      store,
      manifest: manifest(),
      git,
      ...(gh ? { gh } : {}),
      ticketId,
      key,
      title,
      ticket,
      ...(signal ? { signal } : {}),
    });
  };
}
