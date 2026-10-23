import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { GhRunner } from '../../integrations/github.js';
import type { GitRunner } from '../../integrations/git.js';
import { getTicket, listTickets } from '../../store/tickets.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { armForcePushLease } from '../../store/worktrees.js';
import { rebaseState } from '../../workflow/rebaseState.js';
import { sendCiFailureToAgent } from './ciFailureOps.js';
import { rebaseOnBase } from './rebaseOnBaseOps.js';
import { deliverToPr, refreshUndelivered, type UndeliveredTracker } from './deliverToPrOps.js';
import { deliverTargets } from '../../workflow/deliverState.js';
import { runShipGates, type ShipGatesDeps } from './shipGatesOps.js';
import { autoDeliverAfterConflict, conflictRounds, verifyMergeResolved, type AutoDeliverDeps } from './autoDeliverOps.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';

/** Host-side seams shared by both ship actions; `extension.ts` supplies them (vscode lives only there). */
export interface CiActionsInput {
  readonly store: Store;
  readonly ticketId: number;
  readonly gh: GhRunner;
  readonly git: GitRunner;
  /** `<globalStorage>/artifacts/<ticket>`: beside the gate logs the sandbox mirror reads (D194). */
  readonly artifactDir: string;
  readonly sandbox: {
    hasUnsynced(ticketId: number): Promise<boolean>;
    /** The sandbox clone's branch fetched into the worktree at `cwd`; the ref, or null (no sandbox / unreadable). */
    cloneRef(ticketId: number, cwd: string): Promise<string | null>;
    /** Sandbox → host, fast-forward only. */
    ensureSynced(ticketId: number): Promise<EnsureSyncResult>;
    recreateNoSync(ticketId: number): Promise<void>;
  };
  /** Re-probe the PRs of this ticket (@arch:GH-03). */
  readonly reprobe: () => Promise<void>;
  readonly confirm: (title: string, detail: string, action: string) => Promise<boolean>;
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
  readonly debug: (message: string) => void;
  readonly drive: () => void;
  readonly deliver: DeliverHost;
  readonly afterServerChange: () => void;
}

/** Runs a repo-declared generator through the shell; async so the extension host never blocks. */
export function runShellCommand(cwd: string, command: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
      resolve({ code, stderr: String(stderr) });
    });
  });
}

/** The host-specific half of `CiActionsInput` (everything `extension.ts` binds to vscode, gh, git and the sandbox). */
export type CiHost = Pick<CiActionsInput, 'gh' | 'git' | 'artifactDir' | 'sandbox' | 'reprobe' | 'confirm' | 'info' | 'error' | 'deliver'>;

export function sendCiFailureAction(i: CiActionsInput): Promise<void> {
  return sendCiFailureToAgent({
    store: i.store, ticketId: i.ticketId, gh: i.gh,
    writeLog: (name, text) => {
      mkdirSync(i.artifactDir, { recursive: true });
      const path = join(i.artifactDir, name);
      writeFileSync(path, text);
      return path;
    },
    confirm: (detail) => i.confirm('Send CI failure to the agent?', detail, 'Send to agent'),
    info: i.info, error: i.error, logError: i.logError, debug: i.debug, drive: i.drive, afterServerChange: i.afterServerChange,
  });
}

/** Rebase every PR of the ticket that is behind its base, one repo at a time; the first failure stops the rest. */
export async function rebaseOnBaseAction(i: CiActionsInput, regenerate: (repo: string) => readonly string[]): Promise<void> {
  try {
    const state = rebaseState(i.store, i.ticketId);
    if (!state.available) {
      i.info(
        state.reason === 'not-behind'
          ? 'Rebase on base is not available: no open pull request is behind its base.'
          : `Rebase on base is not available (${state.reason}).`,
      );
      return;
    }
    for (const pr of state.prs) {
      let failed = false;
      await rebaseOnBase({
        repo: pr.repo, cwd: pr.cwd, branch: pr.branch, baseRef: pr.baseRef, regenerate: regenerate(pr.repo),
        git: async (cwd, args) => {
          const r = await i.git([...args], cwd);
          return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        },
        runScript: runShellCommand,
        agentActive: () => getTicket(i.store, i.ticketId).agentState === 'running',
        sandboxUnsynced: () => i.sandbox.hasUnsynced(i.ticketId),
        preShip: pr.preShip === true,
        armLease: pr.number === null ? undefined : () => armForcePushLease(i.store, i.ticketId, pr.repo),
        prHeadSha: async () => {
          if (pr.number === null) throw new Error('no pull request to read');
          const r = await i.gh(['pr', 'view', String(pr.number), '--json', 'headRefOid', '--jq', '.headRefOid'], pr.cwd);
          const sha = r.stdout.trim();
          if (r.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`gh could not read the head of PR #${pr.number}`);
          return sha;
        },
        removeSandbox: () => i.sandbox.recreateNoSync(i.ticketId),
        reopenSandbox: async () => {},
        reprobe: async () => {
          if (pr.preShip) return;
          clearOpenPrProbe(i.store, i.ticketId, pr.repo);
          await i.reprobe();
        },
        confirm: (detail) => i.confirm('Rebase on base?', detail, 'Rebase and push'),
        info: i.info,
        error: (m) => { failed = true; i.error(m); },
        logError: i.logError,
        afterServerChange: () => {},
      });
      if (failed) return;
    }
  } finally {
    i.afterServerChange();
  }
}

/** Ship-stage "Deliver to PR" host seams beyond the shared ones. */
export interface DeliverHost {
  /** Ship's push with `deliverToOpenPr` (the saga seam). */
  readonly runShip: () => Promise<void>;
  /** The sync blocker prompt (Open sync diff / Carry). */
  readonly blocked: (reason: string, rewritten: boolean, cliUnknown?: boolean) => Promise<void>;
  readonly tracker: UndeliveredTracker;
}

const gitFor = (i: Pick<CiActionsInput, 'git'>) => async (cwd: string, args: readonly string[]) => {
  const r = await i.git([...args], cwd);
  return { code: r.exitCode, stdout: r.stdout };
};

/** Measure what is not on the PR yet; runs on the PR refresh, never per render. */
export function refreshUndeliveredFor(i: Pick<CiActionsInput, 'store' | 'ticketId' | 'git' | 'sandbox'>, tracker: UndeliveredTracker): Promise<void> {
  return refreshUndelivered(tracker, i.ticketId, deliverTargets(i.store, i.ticketId), {
    git: gitFor(i),
    sandboxRef: (cwd) => i.sandbox.cloneRef(i.ticketId, cwd),
  });
}

export async function deliverToPrAction(i: CiActionsInput): Promise<void> {
  const h = i.deliver;
  await deliverToPr({
    targets: () => deliverTargets(i.store, i.ticketId),
    agentActive: () => getTicket(i.store, i.ticketId).agentState === 'running',
    ensureSynced: () => i.sandbox.ensureSynced(i.ticketId),
    blocked: h.blocked,
    runShip: h.runShip,
    reprobe: async () => {
      await i.reprobe();
      await refreshUndeliveredFor(i, h.tracker);
    },
    info: i.info, error: i.error, logError: i.logError, afterServerChange: i.afterServerChange,
  });
}

/** Karst's own delivery of a resolved merge conflict, run when the Resolve-conflicts session goes idle (D247). */
export function autoDeliverAction(
  i: CiActionsInput,
  extra: Pick<AutoDeliverDeps, 'key' | 'status' | 'log'> & { readonly gate: ShipGatesDeps },
): Promise<void> {
  const h = i.deliver;
  return autoDeliverAfterConflict({
    ticketId: i.ticketId,
    key: extra.key, status: extra.status, log: extra.log,
    rounds: conflictRounds,
    runGates: (prs) => runShipGates(prs, extra.gate),
    targets: () => deliverTargets(i.store, i.ticketId),
    agentActive: () => getTicket(i.store, i.ticketId).agentState === 'running',
    ensureSynced: () => i.sandbox.ensureSynced(i.ticketId),
    verifyMerge: (pr, round) => verifyMergeResolved(gitFor(i), pr.cwd, round),
    blocked: h.blocked,
    runShip: h.runShip,
    reprobe: async () => {
      await i.reprobe();
      await refreshUndeliveredFor(i, h.tracker);
    },
    info: i.info, error: i.error, logError: i.logError, afterServerChange: i.afterServerChange,
  });
}

/** The ship-tick sweep: refresh the undelivered counts of every ship-stage ticket; true when any changed. */
export async function refreshUndeliveredForShipTickets(
  i: Pick<CiActionsInput, 'store' | 'git' | 'sandbox'> & { readonly projectId: number; readonly logError: CiActionsInput['logError'] },
  tracker: UndeliveredTracker,
): Promise<boolean> {
  let moved = false;
  try {
    for (const t of listTickets(i.store, { projectId: i.projectId })) {
      if (t.stageCurrent !== 'ship' || t.archivedAt !== null) continue;
      const before = JSON.stringify(tracker.get(t.id) ?? null);
      await refreshUndeliveredFor({ ...i, ticketId: t.id }, tracker);
      moved ||= before !== JSON.stringify(tracker.get(t.id) ?? null);
    }
  } catch (e) {
    i.logError('karst: undelivered-commit count failed', e);
  }
  return moved;
}

/** The sync-blocker prompt of "Deliver to PR": nothing was pushed; offer the existing sync diff. */
export function deliverBlockedPrompt(
  warn: (message: string, ...actions: string[]) => PromiseLike<string | undefined>,
  openDiff: () => Promise<unknown>,
): DeliverHost['blocked'] {
  return async (reason, rewritten, cliUnknown) => {
    // The sandbox CLI cannot run from this extension host: a sync diff cannot help, fix the PATH.
    if (cliUnknown) {
      await warn(`Deliver to PR stopped: ${reason} Put the CLI on the PATH of the VS Code extension host (start VS Code from a shell that has it), then retry. Nothing was pushed.`);
      return;
    }
    const hint = rewritten ? ' Use "Carry sandbox commits onto host branch" on the dashboard.' : '';
    const pick = await warn(`Deliver to PR stopped: the sandbox is not in sync (${reason}). Nothing was pushed.${hint}`, 'Open sync diff');
    if (pick === 'Open sync diff') await openDiff();
  };
}
