import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { GhRunner } from '../../integrations/github.js';
import type { GitRunner } from '../../integrations/git.js';
import { getTicket } from '../../store/tickets.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { rebaseState } from '../../workflow/rebaseState.js';
import { sendCiFailureToAgent } from './ciFailureOps.js';
import { rebaseOnBase } from './rebaseOnBaseOps.js';

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
export type CiHost = Pick<CiActionsInput, 'gh' | 'git' | 'artifactDir' | 'sandbox' | 'reprobe' | 'confirm' | 'info' | 'error'>;

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
      i.info('Rebase on base is not available: no open pull request is behind its base.');
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
        prHeadSha: async () => {
          const r = await i.gh(['pr', 'view', String(pr.number), '--json', 'headRefOid', '--jq', '.headRefOid'], pr.cwd);
          const sha = r.stdout.trim();
          if (r.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`gh could not read the head of PR #${pr.number}`);
          return sha;
        },
        removeSandbox: () => i.sandbox.recreateNoSync(i.ticketId),
        reopenSandbox: async () => {},
        reprobe: async () => {
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
