/**
 * Node execution workspace provider (Slice 5 Task 1).
 *
 * A workspace is an INDEPENDENT clone of a canonical ticket worktree: its own
 * working tree, index, HEAD/refs namespace and writable Git metadata. An
 * ordinary linked worktree sharing mutable common metadata is insufficient
 * for concurrent writers — a local clone (`git clone --local`, same
 * filesystem only) may share immutable object storage but never writable
 * refs/index state; a cross-device target falls back to a full clone.
 *
 * Workspaces are cut from the canonical integration heads observed when the
 * activation was CLAIMED (the `base_heads` the host stores on the node run),
 * so sibling fan-out activations of one predecessor — whose completion
 * already integrated — start from the same already-integrated state.
 *
 * Location (Decision 15): `<globalStorage>/graph/<projectSlug>/<ticketId>/
 * <graphRunId>/workspaces/<nodeRunId>/<repoName>/` — outside every worktree,
 * so `ship`'s `git add -A` cannot see it and no exclude rule is needed.
 *
 * Byte accounting: the graph run's durable `workspace_bytes` total plus a
 * per-node ledger must stay under `maxAggregateWorkspaceBytes`; exceeding it
 * blocks with `graph-budget-exhausted` rather than starting another clone.
 * The increment is committed inside ONE `BEGIN IMMEDIATE` transaction with an
 * affected-row check — the double-spend guard for the aggregate ceiling.
 *
 * A pre-existing workspace directory belongs to a superseded node run. It is
 * removed ONLY after process attribution (`runtime/serverIdentity.ts`)
 * proves nothing live serves it; a live (or unprovable) process blocks.
 *
 * Host-agnostic: store, transaction, git runner, probes and the device/byte
 * decisions are injected; no vscode. Registration of workspace processes with
 * the `servers` registry is the LAUNCH path's job — the provider returns the
 * per-repo `cwd`s for exactly that.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isPathUnder, canonicalPath } from '../../../runtime/pathScope.js';
import { attributeServer, type ProcessFactsSource } from '../../../runtime/serverIdentity.js';
import { workspaceRootDir } from '../artifacts/snapshot.js';
import { domainKeyOf } from '../integration/domains.js';
import { describeGitFailure, type GitRunner } from '../../../integrations/git.js';
import type { GraphDb } from '../../../store/graph/transitions.js';
import {
  addWorkspaceBytes,
  recordWorkspace,
  workspaceBytesOf,
} from '../../../store/graph/nodeRuns.js';

/** One repository domain the workspace clones: its name, the canonical
 *  worktree it is cut from, and the claim-time head it must start at. */
export interface WorkspaceDomain {
  repoName: string;
  canonicalWorktreePath: string;
  gitCommonDir: string | null;
  baseCommit: string;
}

/** One created clone, for the launch path to register by `cwd`. */
export interface WorkspacePath {
  repoName: string;
  cwd: string;
  /** The physical-domain key (`integration/domains.ts`) this clone serves. */
  domainKey: string;
}

export interface NodeWorkspaceDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  git: GitRunner;
  /** `graph.limits.maxAggregateWorkspaceBytes` for this project. */
  maxAggregateWorkspaceBytes: number;
  /** Extension GLOBAL storage root (Decision 15). */
  globalStorageRoot: string;
  now: () => string;
  /**
   * OS process probes (`runtime/serverIdentity.ts`), injected for tests. The
   * attribution-first rule for removing a superseded workspace depends on
   * them: a directory with a live (or unprovable) process is never deleted.
   */
  facts: ProcessFactsSource;
  /** Same-filesystem decision for `git clone --local`. Default: `stat().dev`
   *  equality. A probe that cannot compare is NOT "same device". */
  sameDevice?: (a: string, b: string) => boolean;
  /** Recursive byte total of a directory (the ceiling's estimate/ledger).
   *  Default: a symlink-safe fs walk. */
  measureBytes?: (dir: string) => number;
  debug?: (message: string) => void;
}

export type CreateNodeWorkspaceResult =
  | { kind: 'created'; paths: WorkspacePath[] }
  | {
      kind: 'budget-exhausted';
      currentBytes: number;
      limitBytes: number;
      estimatedBytes: number;
    }
  | { kind: 'live-process'; reason: string };

/** The mandated per-node workspace path (Decision 15). */
export function nodeWorkspaceDir(
  globalStorageRoot: string,
  projectSlug: string,
  ticketId: number,
  graphRunId: number,
  nodeRunId: number,
): string {
  return join(workspaceRootDir(globalStorageRoot, projectSlug, ticketId, graphRunId), String(nodeRunId));
}

function sameDeviceDefault(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/** Recursive byte total. Symlinks are skipped so a link loop can never walk
 *  forever; a raced deletion just stops counting that subtree. */
function measureBytesDefault(dir: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* raced deletion */
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

/**
 * Whether ANY live process provably-or-possibly serves `dir`, from the
 * `servers` registry rows whose recorded cwd sits at/under it. Only `dead`/
 * `foreign` attributions are safe to remove a tree over; `attributable` and
 * `unknown` both block — a lookup that failed must never read as "no process".
 */
async function liveProcessUnder(deps: NodeWorkspaceDeps, dir: string): Promise<boolean> {
  const rows = deps.db
    .prepare("SELECT pid, cwd, started_at FROM servers WHERE status = 'running' AND cwd IS NOT NULL")
    .all() as { pid: number | null; cwd: string; started_at: string | null }[];
  for (const row of rows) {
    if (!isPathUnder(row.cwd, dir)) continue;
    const pid = row.pid;
    const facts = deps.facts;
    if (pid == null || !Number.isInteger(pid) || pid <= 0) return true; // undecidable → live
    const [alive, liveCwd, processStartMs] = await Promise.all([
      facts.isAlive(pid),
      facts.liveCwd(pid),
      facts.processStartMs(pid),
    ]);
    const attribution = attributeServer(
      { pid, cwd: row.cwd, startedAt: row.started_at },
      { isAlive: () => alive, liveCwd: () => liveCwd, processStartMs: () => processStartMs },
    );
    if (attribution === 'attributable' || attribution === 'unknown') return true;
  }
  return false;
}

/**
 * Create (or, for a superseded node run, re-create) the node's isolated
 * workspaces. Returns the per-repo paths for the launch path to register with
 * the `servers` registry by `cwd`. Blocks with `budget-exhausted` or
 * `live-process` rather than ever mutating the canonical worktrees.
 */
export async function createNodeWorkspace(
  deps: NodeWorkspaceDeps,
  input: {
    projectSlug: string;
    ticketId: number;
    graphRunId: number;
    nodeRunId: number;
    domains: readonly WorkspaceDomain[];
  },
): Promise<CreateNodeWorkspaceResult> {
  const { db, transaction, git } = deps;
  const nodeDir = nodeWorkspaceDir(
    deps.globalStorageRoot,
    input.projectSlug,
    input.ticketId,
    input.graphRunId,
    input.nodeRunId,
  );
  const measureBytes = deps.measureBytes ?? measureBytesDefault;
  const sameDevice = deps.sameDevice ?? sameDeviceDefault;

  // 1. Byte-ceiling gate: recorded total + the new clone's estimated bytes.
  const currentBytes = workspaceBytesOf(db, input.graphRunId);
  let estimatedBytes = 0;
  for (const domain of input.domains) estimatedBytes += measureBytes(domain.canonicalWorktreePath);
  if (currentBytes + estimatedBytes > deps.maxAggregateWorkspaceBytes) {
    deps.debug?.(
      `[graph] workspace: node ${input.nodeRunId} refused — ${currentBytes + estimatedBytes} bytes over the ${deps.maxAggregateWorkspaceBytes} aggregate ceiling`,
    );
    return {
      kind: 'budget-exhausted',
      currentBytes,
      limitBytes: deps.maxAggregateWorkspaceBytes,
      estimatedBytes,
    };
  }

  // 2. A pre-existing workspace belongs to a superseded node run. Removal goes
  //    through process attribution FIRST: a live (or unprovable) process under
  //    it blocks, never deletes.
  if (existsSync(nodeDir)) {
    if (await liveProcessUnder(deps, nodeDir)) {
      deps.debug?.(
        `[graph] workspace: node ${input.nodeRunId} blocked — a live process serves the existing workspace ${nodeDir}`,
      );
      return {
        kind: 'live-process',
        reason: `node run ${input.nodeRunId} already has a workspace with a live process — it will not be removed`,
      };
    }
    deps.debug?.(
      `[graph] workspace: removing superseded workspace of node run ${input.nodeRunId} (no live process)`,
    );
    rmSync(nodeDir, { recursive: true, force: true });
  }

  // 3. Clone each repository at its claim-time base commit: local on the same
  //    filesystem (shared immutable objects, own refs/index/worktree), full
  //    otherwise. Never writes to the canonical worktree.
  mkdirSync(nodeDir, { recursive: true });
  const created: { domain: WorkspaceDomain; cwd: string; bytes: number }[] = [];
  const paths: WorkspacePath[] = [];
  try {
    for (const domain of input.domains) {
      const dest = join(nodeDir, domain.repoName);
      const local = sameDevice(nodeDir, domain.canonicalWorktreePath);
      const clone = await git(
        local
          ? ['clone', '--local', '-q', domain.canonicalWorktreePath, dest]
          : ['clone', '-q', domain.canonicalWorktreePath, dest],
        nodeDir,
      );
      if (clone.exitCode !== 0) {
        throw new Error(describeGitFailure(`git clone of ${domain.repoName} into ${dest}`, clone));
      }
      const co = await git(['checkout', '-q', '--detach', domain.baseCommit], dest);
      if (co.exitCode !== 0) {
        throw new Error(
          describeGitFailure(`git checkout --detach ${domain.baseCommit} in ${dest}`, co),
        );
      }
      const bytes = measureBytes(dest);
      created.push({ domain, cwd: dest, bytes });
      paths.push({
        repoName: domain.repoName,
        cwd: dest,
        domainKey: domainKeyOf(canonicalPath(domain.canonicalWorktreePath), domain.gitCommonDir),
      });
      deps.debug?.(
        `[graph] workspace: node ${input.nodeRunId} cloned ${domain.repoName} → ${dest} (${local ? 'local' : 'full'}, ${bytes} bytes) at ${domain.baseCommit}`,
      );
    }
  } catch (err) {
    rmSync(nodeDir, { recursive: true, force: true });
    throw err;
  }

  // 4. Record the clones + byte total durably, re-checking the ceiling inside
  //    the write lock (another window may have recorded bytes since step 1).
  const ledgerBytes = created.reduce((sum, c) => sum + c.bytes, 0);
  const committed = transaction(() => {
    const nowTotal = workspaceBytesOf(db, input.graphRunId);
    if (nowTotal + ledgerBytes > deps.maxAggregateWorkspaceBytes) return false;
    for (const c of created) {
      recordWorkspace(db, {
        graphRunId: input.graphRunId,
        nodeRunId: input.nodeRunId,
        repoName: c.domain.repoName,
        cwd: c.cwd,
        byteSize: c.bytes,
        now: deps.now(),
      });
    }
    if (!addWorkspaceBytes(db, input.graphRunId, ledgerBytes)) {
      throw new Error(`workspace byte counter moved for graph run ${input.graphRunId}`);
    }
    return true;
  });
  if (!committed) {
    deps.debug?.(
      `[graph] workspace: node ${input.nodeRunId} refused at commit — aggregate ceiling reached`,
    );
    rmSync(nodeDir, { recursive: true, force: true });
    return {
      kind: 'budget-exhausted',
      currentBytes: workspaceBytesOf(db, input.graphRunId),
      limitBytes: deps.maxAggregateWorkspaceBytes,
      estimatedBytes: ledgerBytes,
    };
  }
  return { kind: 'created', paths };
}
