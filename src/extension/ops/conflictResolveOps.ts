import type { SandboxProbe } from '../../agent/sessionRunner.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';

/**
 * The two decisions behind a "Resolve conflicts" click, shared by the ticket
 * dashboard and the sidebar mini-dashboard. Both are host-agnostic: the caller
 * injects the store-backed brief, the session seams and the vscode toast.
 */

/**
 * Pick the brief for this click and either decline it or deliver it.
 *
 * Async because the environment comes from the runners' LISTING, not from a
 * path helper: `bridgeOf` names a bridge path for every ticket whenever the
 * bridge root exists, which handed host tickets (T758, T765) the sandbox brief.
 * A listing that cannot answer (no CLI, `ENOENT` as 127, a failed listing, a
 * rejected probe) is `unknown` (arch:AC-39): no brief is picked, the user is told
 * why. Falling back to the host brief would send a possibly sandboxed ticket's
 * agent at the wrong environment.
 *
 * The STORE decides whether the conflict still exists — `repo` arrived in a
 * webview message, and a stale panel can name one that has since gone, so a
 * null brief is a message to the user, never a generic session.
 */
export interface ResolveConflictInput {
  /** The repo the click named; passed through untouched. */
  readonly repo: string;
  /** The ticket label for the "nothing to resolve" message. */
  readonly label: string;
  readonly probeSandbox: () => Promise<SandboxProbe>;
  readonly briefFor: (sandboxed: boolean) => string | null;
  readonly notify: (message: string) => void;
  readonly deliver: (brief: string, repo: string) => void;
  /** Called once the brief is going out: arms Karst's own delivery of the resolved merge (D247). */
  readonly arm?: (repo: string) => void;
  /**
   * Sandboxed tickets only: sync both ways with the conflict's base ref, so the clone's
   * `refs/karst/base/<base>` is fresh BEFORE the brief goes out (a live terminal is only nudged,
   * and a stale ref makes the agent's merge say "Already up to date"). A failure sends no brief.
   */
  readonly prepareSandbox?: () => Promise<EnsureSyncResult>;
}

const DIRTY_HINT = ' Use "Stash and update" on the dashboard Sandbox card to park the sandbox changes, then click Resolve conflicts again.';

/**
 * Why a round did not go out. `sandbox-sync` is an ENVIRONMENT blocker (dirty or diverged clone at the pre-round
 * refresh, AC-46): a retry cannot fix it. The others are not an agent failure either.
 */
export type RoundRefusal = 'placement-unknown' | 'no-conflict' | 'sandbox-sync' | 'launch-failed' | 'lease-lost';

export type ConflictRoundResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'refused'; readonly cause: RoundRefusal; readonly message: string; readonly reason: string };

async function prepare(input: ResolveConflictInput): Promise<ConflictRoundResult | null> {
  if (!input.prepareSandbox) return null;
  const result = await input.prepareSandbox().catch((err: unknown): EnsureSyncResult => ({ ok: false, reason: err instanceof Error ? err.message : String(err), diverged: false }));
  if (result.ok) return null;
  const dirty = /uncommitted/i.test(result.reason);
  return {
    kind: 'refused', cause: 'sandbox-sync', reason: result.reason,
    message: `Could not refresh the sandbox of ticket ${input.label} with the latest base branch, so no conflict brief was sent: ${result.reason}.${dirty ? DIRTY_HINT : ''}`,
  };
}

/** The decision behind a Resolve-conflicts click, as data: the click toasts a refusal, autopilot parks on it. */
export async function resolveConflictRound(input: ResolveConflictInput): Promise<ConflictRoundResult> {
  // A probe that REJECTS cannot say either: unknown, never "no sandbox".
  const probe = await input.probeSandbox().catch((err: unknown): SandboxProbe => ({ state: 'unknown', reason: err instanceof Error ? err.message : String(err) }));
  if (probe.state === 'unknown') {
    return {
      kind: 'refused', cause: 'placement-unknown', reason: probe.reason,
      message: `Could not tell whether ticket ${input.label} runs in a sandbox, so no conflict brief was sent: ${probe.reason}. Make sure the sbx/docker CLI is on the PATH of the VS Code extension host.`,
    };
  }
  const sandboxed = probe.state === 'present';
  const brief = input.briefFor(sandboxed);
  if (brief === null) {
    const message = `No merge conflict is recorded for "${input.repo}" on ticket ${input.label} — nothing to resolve.`;
    return { kind: 'refused', cause: 'no-conflict', message, reason: message };
  }
  if (sandboxed) {
    const failure = await prepare(input);
    if (failure !== null) return failure;
  }
  input.arm?.(input.repo);
  input.deliver(brief, input.repo);
  return { kind: 'sent' };
}

export async function resolveConflictClick(input: ResolveConflictInput): Promise<void> {
  const result = await resolveConflictRound(input);
  if (result.kind === 'refused') input.notify(result.message);
}

/**
 * Deliver a prompt to the ticket's session, live or not: nudge the open
 * terminal, else launch one seeded with it. A conflict brief handed to
 * `openSession` alone would be dropped whenever a session is already up —
 * `openSession` only focuses an existing terminal.
 *
 * A graph ticket is never nudged from here: the graph coordinator owns its
 * sessions (entry-point matrix, Slice 3 Task 7).
 */
export interface SessionHandOffDeps {
  readonly isGraphTicket: () => boolean;
  readonly nudge: (prompt: string) => boolean;
  readonly focus: () => void;
  readonly open: (seedPrompt: string, seedRepo: string) => void;
}

export function makeSessionHandOff(
  deps: SessionHandOffDeps,
): (prompt: string, repo: string) => void {
  return (prompt, repo) => {
    if (deps.isGraphTicket()) return;
    if (deps.nudge(prompt)) {
      deps.focus();
      return;
    }
    deps.open(prompt, repo);
  };
}
