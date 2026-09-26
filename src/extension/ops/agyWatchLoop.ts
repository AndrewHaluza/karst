import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { HookChannelRecorder } from '../../diagnostics/hookChannel.js';
import {
  agyWatchTick,
  findConversationForWorktree,
  openAgyConversationDb,
  resolveAgyAppDataDir,
  type AgyConversationSnapshot,
  type AgyWatchState,
} from '../../agent/agyConversationWatch.js';
import { agyUsageTick, type AgyConversationUsage, type AgyUsageState } from '../../agent/agyUsageWatch.js';
import { dispatchHook, type HookPayload } from '../../hooks/dispatch.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';

/** How often the Agy conversation watch re-sweeps live terminals. */
export const AGY_WATCH_INTERVAL_MS = 10_000;

/** The slice of `TerminalIdentity` the sweep needs to route an event. */
export interface AgyTerminalNamed {
  readonly ticketId: number;
  readonly launchId?: string;
  readonly identity?: { readonly provider?: string };
}

export interface AgyWatchLoopDeps {
  readonly store: Store;
  /** The terminals currently open in the window. */
  readonly listTerminals: () => Iterable<unknown>;
  /** Resolve a terminal to its ticket identity, or `undefined` if unnamed. */
  readonly identifyTerminal: (terminal: unknown) => AgyTerminalNamed | undefined;
  /** Per-ticket memory of the lifecycle watch (conversation db, pending state). */
  readonly agyWatchStates: Map<number, AgyWatchState>;
  /** Per-ticket memory of the usage watch (last emitted event id). */
  readonly agyUsageStates: Map<number, AgyUsageState>;
  readonly notifyHook: (ticketId: number, payload: HookPayload) => void;
  readonly shouldApplyHookState: (ticketId: number, payload: HookPayload) => boolean;
  readonly sessionProviderFor: (ticketId: number) => AgentProvider | null;
  readonly hookChannelRecorder: HookChannelRecorder;
  readonly debug: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
}

export interface AgyWatchLoop {
  /** Run one sweep now. Re-entrancy-safe: a call while one is in flight is a no-op. */
  run(): void;
}

/**
 * Antigravity conversation watch: agy 1.1.11 executes no hooks in the CLI
 * (its hooks.json loads but never runs — see docs/guides/adding-agent-core.md
 * § Antigravity), so its lifecycle signals are READ, not pushed — from the
 * CLI's own conversation DB. A permission ask is a `steps` row with
 * status = 9, observed while the approval dialog is on screen; answering
 * resolves it to status = 3. The sweep locates the conversation by the
 * worktree path stored in the DB's workspace blob, diffs the pending
 * approval state per ticket, and posts the normalized events (SessionStart /
 * permission.asked / UserPromptSubmit) through the SAME dispatchHook seam
 * and closures as the hook endpoint, so session-id capture (--conversation
 * resume), launch-intent confirmation, the generation barrier, the amber
 * glyph, the Now line and the dashboard refresh are shared. Session end →
 * idle is the terminal-close sweep's job, not this one's.
 *
 * Conversation-DB token usage: agy 1.1.12 persists per-call usage in this
 * same DB (steps.metadata field-9 submessage — see agyUsageWatch.ts), so the
 * lifecycle watch doubles as the usage channel. The cumulative sample rides
 * the same UsageUpdate seam and closures as the codex/opencode bridges —
 * attribution (impl segment vs fix), the generation barrier, and the store's
 * cumulative-delta ledger are shared. A re-sweep of an unchanged DB emits
 * nothing; the store dedupes on event id anyway.
 */
export function createAgyWatchLoop(deps: AgyWatchLoopDeps): AgyWatchLoop {
  let running = false;

  /**
   * Dispatch any UsageUpdate observation for the ticket's current usage
   * snapshot. `logEachEvent`/`passDebugToDispatch` mirror the two call sites
   * of the original inline code, which logged and threaded `logger.debug`
   * through slightly differently depending on whether a lifecycle event had
   * already fired this tick.
   */
  const dispatchUsage = (
    named: AgyTerminalNamed,
    worktree: { readonly path: string },
    snapshot: AgyConversationSnapshot | null,
    agyUsage: AgyConversationUsage | null,
    opts: { readonly logEachEvent: boolean; readonly passDebugToDispatch: boolean },
  ): void => {
    const usageState = deps.agyUsageStates.get(named.ticketId) ?? { eventId: null };
    const usageEvents = agyUsageTick(usageState, agyUsage);
    deps.agyUsageStates.set(named.ticketId, usageState);
    for (const event of usageEvents) {
      if (opts.logEachEvent) {
        deps.debug(`[agy] ticket ${named.ticketId}: dispatching UsageUpdate event_id=${event.usage.event_id}`);
      }
      const usagePayload: HookPayload = {
        hook_event_name: 'UsageUpdate',
        cwd: worktree.path,
        session_id: snapshot?.conversationId ?? '',
        usage: event.usage,
        ...(named.launchId ? { launchId: named.launchId } : {}),
      };
      try {
        dispatchHook(
          deps.store,
          usagePayload,
          deps.notifyHook,
          deps.shouldApplyHookState,
          deps.sessionProviderFor,
          deps.hookChannelRecorder,
          ...(opts.passDebugToDispatch ? [deps.debug] : []),
        );
      } catch (error) {
        deps.logError(`karst: agy usage dispatch failed for ticket ${named.ticketId}`, error);
      }
    }
  };

  const run = (): void => {
    if (running) return;
    running = true;
    try {
      const appDataDir = resolveAgyAppDataDir();
      const terminals = [...deps.listTerminals()];
      deps.debug(`[agy] sweep tick: ${terminals.length} terminals`);
      for (const terminal of terminals) {
        const named = deps.identifyTerminal(terminal);
        if (named?.identity?.provider !== 'antigravity') continue;
        const worktree = listWorktreesByTicket(deps.store, named.ticketId)[0];
        if (!worktree) {
          deps.debug(`[agy] ticket ${named.ticketId}: no worktree found`);
          continue;
        }
        let snapshot: AgyConversationSnapshot | null = null;
        let agyUsage: AgyConversationUsage | null = null;
        try {
          const found = findConversationForWorktree(appDataDir, worktree.path);
          if (found) {
            const db = openAgyConversationDb(found.dbPath);
            try {
              snapshot = {
                dbPath: found.dbPath,
                conversationId: found.conversationId,
                pendingApproval: db.pendingApprovalCount() > 0,
              };
              // Read usage while the DB is open — the lifecycle watch
              // doubles as the usage channel for antigravity sessions.
              agyUsage = db.usage();
            } finally {
              db.close();
            }
          }
        } catch (error) {
          deps.logError(`karst: agy conversation read failed for ticket ${named.ticketId}`, error);
          continue;
        }
        deps.debug(
          `[agy] ticket ${named.ticketId}: conversation=${snapshot?.conversationId ?? 'none'}, usage=${agyUsage ? `${agyUsage.input}/${agyUsage.output}/${agyUsage.cacheRead}` : 'null'}, launchId=${named.launchId ?? 'none'}`,
        );
        const state =
          deps.agyWatchStates.get(named.ticketId) ?? { dbPath: null, started: false, awaiting: false };
        const events = agyWatchTick(state, snapshot);
        if (events.length === 0) {
          // Lifecycle produced no events, but still dispatch any usage
          // observation (the usage read is outside the lifecycle continue).
          dispatchUsage(named, worktree, snapshot, agyUsage, {
            logEachEvent: true,
            passDebugToDispatch: false,
          });
          continue;
        }
        deps.agyWatchStates.set(named.ticketId, state);
        // The session id for non-SessionStart events is the CURRENT
        // conversation's id — the same one SessionStart carried.
        const conversationId = snapshot?.conversationId;
        for (const event of events) {
          const base = {
            cwd: worktree.path,
            session_id: event.kind === 'SessionStart' ? event.sessionId : (conversationId ?? undefined),
            ...(named.launchId ? { launchId: named.launchId } : {}),
          };
          const payload: HookPayload =
            event.kind === 'SessionStart'
              ? { hook_event_name: 'SessionStart', ...base }
              : event.kind === 'permission.asked'
                ? { hook_event_name: 'permission.asked', ...base }
                : { hook_event_name: 'UserPromptSubmit', ...base };
          try {
            dispatchHook(
              deps.store,
              payload,
              deps.notifyHook,
              deps.shouldApplyHookState,
              deps.sessionProviderFor,
              deps.hookChannelRecorder,
              deps.debug,
            );
          } catch (error) {
            deps.logError(`karst: agy watch dispatch failed for ticket ${named.ticketId}`, error);
          }
        }
        // Conversation-DB token usage: agy 1.1.12 persists per-call usage in
        // this same DB (steps.metadata field-9 submessage — see
        // agyUsageWatch.ts), so the lifecycle watch doubles as the usage
        // channel. The cumulative sample rides the same UsageUpdate seam and
        // closures as the codex/opencode bridges — attribution (impl segment
        // vs fix), the generation barrier, and the store's cumulative-delta
        // ledger are shared. A re-sweep of an unchanged DB emits nothing; the
        // store dedupes on event id anyway.
        dispatchUsage(named, worktree, snapshot, agyUsage, {
          logEachEvent: false,
          passDebugToDispatch: true,
        });
      }
    } catch (error) {
      deps.logError('karst: agy conversation watch failed', error);
    } finally {
      running = false;
    }
  };

  return { run };
}
