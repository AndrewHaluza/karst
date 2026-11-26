/**
 * T1380 — the host seam that parks a graph node/planner on its provider usage
 * limit and asks the person what to do.
 *
 * The signal arrives twice: from an opencode/opencode2 `session.error` hook
 * (`GraphLaunchOwner`) and from the Claude host transcript sweep
 * (`GraphClaudeUsageLimitSignal`). Both land here as one `GraphUsageLimitSignal`.
 *
 * The durable park is `parkGraphUsageLimit` (@arch:GRAPH-AUTORECOVERY): one
 * transaction blocks the role row and the graph run, releases a process slot
 * and (after commit) terminates the session through the transport. Only the
 * window that wins the park CAS offers the prompt, so a reload or a second
 * signal for an already-blocked run never asks again.
 *
 * The prompt mirrors the interactive one (`runInteractiveOffer`):
 * Pick agent/model… (a QuickPick, then ONLY the parked role's snapshot entry is
 * replaced) → Resume; Pick account… (T1386, only when the parked core has
 * another account: the user pins that account for the parked role of THIS run,
 * then Resume); Retry same → Resume; Dismiss → the blocked banner keeps
 * Resume and Replan. Karst never switches a core or account by itself.
 */

import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import type { Manifest, GraphApproachConfig, AgentProvider } from '../manifest/types.js';
import { graphRunAgentIdentity, graphRunById } from '../store/graph/graphRuns.js';
import { graphRunProcessIdentity, type GraphLaunchOwner, type GraphSessionRole } from '../store/graph/sessionOwners.js';
import {
  GRAPH_ROLES,
  parseRunIdentities,
  resolveRunIdentities,
  type RoleIdentity,
  type GraphRole,
} from '../approaches/graph/runIdentity.js';
import {
  switchGraphRunAccount,
  switchGraphRunModels,
  type SwitchAccountOutcome,
  type SwitchModelsOutcome,
} from '../approaches/graph/modelChange.js';
import type { GraphLaunchTicketFields } from '../approaches/graph/profileResolver.js';
import { parkGraphUsageLimit } from '../approaches/graph/coordinator/usageLimitPark.js';
import type { RecoveryRefusalReason } from '../approaches/graph/coordinator/recovery.js';
import { blockGraphStage } from '../workflow/graphMarkerGuard.js';
import type { SupervisedAgentSession, TerminationProof } from '../approaches/graph/transport/agentTransport.js';
import type { AccountStatus } from '../agent/accounts/accountOps.js';
import { DEFAULT_ACCOUNT, type AccountsConfig } from '../agent/accounts/types.js';
import { dispatchGraphRecovery, type GraphRecoverySeams } from './ops/graphRecoveryDispatch.js';
import {
  graphRecoveryRefusalNotice,
  graphRefusalContext,
  projectMaxReplans,
} from './ops/graphRecovery.js';
import {
  PICK_LABEL,
  PICK_ACCOUNT_LABEL,
  RETRY_LABEL,
  DISMISS_LABEL,
} from './ops/interactiveUsageLimitActions.js';
import { ask, toast } from './toastSeam.js';
import { reasonText } from '../model/notifyText.js';

/** The backoff for a lock-contended presentation write: 50+100+200+400+800 ms. */
const BUSY_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

/** A write lock held by another connection (the coordinator has no busy timeout). */
function isLockContention(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { code?: string }).code?.startsWith('SQLITE_BUSY') === true ||
      /database is (locked|busy)/i.test(err.message))
  );
}

function defaultPause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One usage-limit signal, either source, with the provider when known. */
export interface GraphUsageLimitSignal {
  ticketId: number;
  graphRunId: number;
  runId: number;
  role: GraphSessionRole;
  /** The parked core; null/absent reads from the role's running process run. */
  provider?: string | null;
  text: string;
}

/** The transport seam the park terminates through (attributable kill only). */
export interface GraphUsageLimitTransport {
  sessions(): readonly SupervisedAgentSession[];
  terminate(session: SupervisedAgentSession): Promise<TerminationProof>;
}

/** One account of the parked core, as the Accounts settings tab lists it. */
export interface GraphAccountRow {
  readonly name: string;
  /** True when a NEW launch of this project would use it. */
  readonly active: boolean;
}

/** One entry of the account QuickPick. */
export interface GraphAccountChoice {
  readonly name: string;
  /** The account the parked session used: the role's pinned account, else the active one. */
  readonly current: boolean;
  /** The signed-in probe of that account folder (@arch:AC-55). */
  readonly status: AccountStatus;
}

export interface GraphUsageLimitBindingDeps {
  /** The graph coordinator store; resolved lazily (created after the hook endpoint). */
  store(): Store | undefined;
  transaction: <T>(fn: () => T) => T;
  now(): string;
  /** The live graph transport; resolved lazily (created after the hook endpoint). */
  transport(): GraphUsageLimitTransport | undefined;
  /** The recovery dispatch seams; resolved lazily. */
  recovery(): GraphRecoverySeams | undefined;
  /** The core → model picker (undefined when the user backs out). */
  pick(
    parkedProvider: string,
    parkedModel: string | null,
  ): PromiseLike<{ provider: AgentProvider; model: string | null } | undefined>;
  manifest(): Manifest | undefined;
  graphConfigOf(approachId: string): GraphApproachConfig | undefined;
  ticketLaunchFieldsOf(ticketId: number): GraphLaunchTicketFields;
  refresh(ticketId: number): void;
  debug(message: string): void;
  logError(message: string, error: unknown): void;
  /** The prompt seam; defaults to `ask.warn` from the toast seam. */
  ask?(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  /** The failure toast; defaults to `toast.error` from the toast seam. */
  toastError?(message: string): void;
  /**
   * The accounts of a core (@arch:AC-55), `default` first and the stored ones
   * after it. Absent, or fewer than two rows, means the parked core has no
   * other account: the prompt offers no account choice.
   */
  accountsOf?(core: string): PromiseLike<readonly GraphAccountRow[] | undefined>;
  /** The signed-in state of one account (the Accounts settings probe). */
  accountStatus?(core: string, name: string): PromiseLike<AccountStatus>;
  /** The account QuickPick; undefined when the user closes it. */
  pickAccount?(core: string, choices: readonly GraphAccountChoice[]): PromiseLike<string | undefined>;
  /**
   * The machine-local accounts config `switchGraphRunAccount` validates the
   * pick against (@arch:AC-55). It is read, never written: a pick writes only
   * the run snapshot (@arch:AC-50, @arch:AC-61).
   */
  accountsConfig?(): AccountsConfig;
  /** One Activity entry for a resumed launch that runs under a pinned account. */
  activity?(ticketId: number, title: string): void;
  /**
   * The async pause between retries of a lock-contended presentation write.
   * The coordinator store has no busy timeout (a synchronous wait would block
   * the extension host), so a post-commit stage write retries here instead of
   * failing the already-committed park. Defaults to a real timer.
   */
  pause?(ms: number): Promise<void>;
}

export interface GraphUsageLimitBinding {
  /** Claude transcript sweep and any unified caller. */
  onGraphUsageLimit(signal: GraphUsageLimitSignal): Promise<void>;
  /** opencode/opencode2 hook `session.error` (`(owner, text)` callback shape). */
  onGraphHookUsageLimit(owner: GraphLaunchOwner, text: string): void;
}

/** The parked role from the process run's agent name, else the role's fallback. */
export function parkedGraphRole(role: GraphSessionRole, agentName: string | null): GraphRole {
  // Stryker disable next-line ConditionalExpression: equivalent — `includes(null)` is already false, so the `agentName !== null` half cannot change the result.
  if (agentName !== null && (GRAPH_ROLES as readonly string[]).includes(agentName)) {
    return agentName as GraphRole;
  }
  return role === 'planner' ? 'expert' : 'worker';
}

/** The truthful reason a pick did not reach the snapshot; the prompt stays open. */
export const graphAccountRefusalNotice = (
  provider: string,
  role: GraphRole,
  account: string,
  outcome: SwitchAccountOutcome,
): string => {
  const cause =
    outcome === 'unknown-account'
      ? `it is not a stored ${provider} account`
      : outcome === 'no-snapshot'
        ? 'the graph run has no identity snapshot'
        : outcome === 'role-missing'
          ? `the ${role} role is not in the run snapshot`
          : 'the graph run no longer exists';
  return `Karst did not switch the graph ${role} of this run to the ${provider} account '${account}': ${cause}.`;
};

/**
 * The Activity text names the account that RUNS. A pick of `default`
 * removes the pin (the plan), so the role follows the active account.
 */
export const graphAccountActivity = (role: GraphRole, chosen: string, active: string | undefined): string =>
  chosen === DEFAULT_ACCOUNT && active !== undefined && active !== DEFAULT_ACCOUNT
    ? `graph ${role} runs under the active account ${active} (picked default at the usage limit)`
    : `graph ${role} runs under account ${chosen} (picked at the usage limit)`;

export function createGraphUsageLimitBinding(deps: GraphUsageLimitBindingDeps): GraphUsageLimitBinding {
  const warn = deps.ask ?? ((message: string, ...actions: string[]) => ask.warn(message, ...actions));
  const toastError = deps.toastError ?? ((message: string) => void toast.error(message));

  /** Terminate the parked session through the transport's attributable kill. */
  const terminateSession = async (target: {
    graphRunId: number;
    role: GraphSessionRole;
    runId: number;
  }): Promise<TerminationProof | undefined> => {
    const transport = deps.transport();
    if (!transport) return undefined;
    const session = transport
      .sessions()
      .find(
        (s) =>
          s.graphRunId === target.graphRunId &&
          s.nodeRunId === target.runId &&
          // A re-attached session may omit its kind (the revived terminal's
          // launch id names the run row, not the role): trust the park's role
          // rather than reading it as a node.
          (s.runKind ?? target.role) === target.role,
      );
    if (!session) return undefined;
    return transport.terminate(session);
  };

  /** Replace ONLY the parked role in the run's snapshot, dropping stale effort. */
  const switchParkedRole = (
    store: Store,
    input: { ticketId: number; graphRunId: number; role: GraphRole; provider: AgentProvider; model: string | null },
  ): SwitchModelsOutcome | undefined => {
    const manifest = deps.manifest();
    if (!manifest) return undefined;
    const run = graphRunById(store.db, input.graphRunId);
    // Stryker disable next-line StringLiteral: equivalent — the caller treats every outcome but switched/unchanged the same, so '' and 'not-found' cannot differ here.
    if (!run) return 'not-found';
    const config = deps.graphConfigOf(run.approach_id);
    const snapshot =
      parseRunIdentities(graphRunAgentIdentity(store.db, input.graphRunId)) ??
      (config ? resolveRunIdentities(manifest, config, deps.ticketLaunchFieldsOf(input.ticketId)) : undefined);
    if (!snapshot) return undefined;
    const previous = snapshot.roles[input.role];
    const next: RoleIdentity = {
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      source: previous?.source ?? 'approach',
    };
    snapshot.roles[input.role] = next;
    return switchGraphRunModels(
      {
        db: store.db,
        transaction: deps.transaction,
        now: deps.now,
        debug: deps.debug,
        manifest,
        graphConfigOf: deps.graphConfigOf,
        ticketLaunchFieldsOf: deps.ticketLaunchFieldsOf,
      },
      input.graphRunId,
      snapshot,
    );
  };

  /**
   * Pin the parked role's account in the run snapshot (T1386, @arch:AC-55).
   * Only the user's pick reaches this; a quota stop never switches the account.
   */
  const switchParkedAccount = (
    store: Store,
    input: { graphRunId: number; role: GraphRole; account: string },
    accounts: AccountsConfig,
  ): SwitchAccountOutcome =>
    switchGraphRunAccount(
      {
        db: store.db,
        transaction: deps.transaction,
        now: deps.now,
        debug: deps.debug,
        accountsConfig: () => accounts,
      },
      input.graphRunId,
      input.role,
      input.account,
    );

  /**
   * The accounts the parked core can offer, with the parked session's account
   * marked. `undefined` when account support is not wired or the core has no
   * second account: one account is no choice (@arch:AC-55).
   */
  const accountChoices = async (
    provider: string,
    pinned: string | undefined,
  ): Promise<{ choices: GraphAccountChoice[]; active: string | undefined } | undefined> => {
    if (!deps.accountsOf || !deps.pickAccount || !deps.accountsConfig) return undefined;
    const rows = await deps.accountsOf(provider);
    if (!rows || rows.length < 2) return undefined;
    const active = rows.find((row) => row.active)?.name;
    const current = pinned ?? active;
    const choices: GraphAccountChoice[] = [];
    for (const row of rows) {
      const status = deps.accountStatus ? await deps.accountStatus(provider, row.name) : 'unknown';
      choices.push({ name: row.name, current: row.name === current, status });
    }
    return { choices, active };
  };

  /** A failed refresh is presentation only; the park already committed. */
  const refreshQuietly = (ticketId: number): void => {
    try {
      deps.refresh(ticketId);
    } catch (error) {
      deps.debug(`[graph] usage-limit: refresh after the park failed: ${reasonText(error)}`);
    }
  };

  /** The post-commit stage block: retried on lock contention, never fatal. */
  const writeStageBlock = async (store: Store, signal: GraphUsageLimitSignal): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        blockGraphStage(store, signal.ticketId, signal.graphRunId, deps.now);
        return;
      } catch (error) {
        const delay = BUSY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isLockContention(error)) {
          deps.debug(
            `[graph] usage-limit: stage block after the park failed (${reasonText(error)}); the run stays blocked`,
          );
          return;
        }
        await (deps.pause ?? defaultPause)(delay);
      }
    }
  };

  /** The truthful refusal notice every other Resume surface shows. */
  const refusalNotice = (
    store: Store,
    ticketId: number,
    graphRunId: number,
    reason: RecoveryRefusalReason,
  ): string => {
    const run = graphRunById(store.db, graphRunId);
    const config = run ? deps.graphConfigOf(run.approach_id) : undefined;
    return graphRecoveryRefusalNotice(
      ticketId,
      'resume',
      reason,
      graphRefusalContext(store.db, graphRunId, projectMaxReplans(config?.limits.maxReplans)),
    );
  };

  const resume = (ticketId: number, graphRunId: number): void => {
    const seams = deps.recovery();
    if (!seams) {
      deps.debug(`[graph] usage-limit: recovery seams not wired, run ${graphRunId} stays blocked`);
      return;
    }
    const result = dispatchGraphRecovery(seams, { ticketId, graphRunId, mode: 'resume' });
    // A refusal must not read as a silent no-op: show the same guidance the
    // blocked banner's Resume shows.
    if (result.kind !== 'refused') return;
    const store = deps.store();
    if (!store) return;
    void warn(refusalNotice(store, ticketId, graphRunId, result.reason));
  };

  const offer = async (input: {
    signal: GraphUsageLimitSignal;
    provider: string;
    model: string | null;
    parkedRole: GraphRole;
    label: string;
  }): Promise<void> => {
    const store = deps.store();
    const snapshot = store
      ? parseRunIdentities(graphRunAgentIdentity(store.db, input.signal.graphRunId))
      : undefined;
    const offered = await accountChoices(input.provider, snapshot?.roles[input.parkedRole]?.account);
    const actions = offered
      ? [PICK_LABEL, PICK_ACCOUNT_LABEL, RETRY_LABEL, DISMISS_LABEL]
      : [PICK_LABEL, RETRY_LABEL, DISMISS_LABEL];
    for (;;) {
      const choice = await warn(input.label, ...actions);
      if (choice === PICK_LABEL) {
        const chosen = await deps.pick(input.provider, input.model);
        // A cancelled picker keeps the park (and the prompt) available.
        if (!chosen) continue;
        if (!store) return;
        const outcome = switchParkedRole(store, {
          ticketId: input.signal.ticketId,
          graphRunId: input.signal.graphRunId,
          role: input.parkedRole,
          provider: chosen.provider,
          model: chosen.model,
        });
        if (outcome === 'switched') {
          resume(input.signal.ticketId, input.signal.graphRunId);
          return;
        }
        // Unchanged/terminal/not-found: let the user pick again or retry.
        if (outcome === 'unchanged') continue;
        return;
      }
      if (choice === PICK_ACCOUNT_LABEL && offered) {
        const chosen = await deps.pickAccount!(input.provider, offered.choices);
        // A cancelled picker keeps the park (and the prompt) available.
        if (chosen === undefined) continue;
        if (!store) return;
        const outcome = switchParkedAccount(
          store,
          { graphRunId: input.signal.graphRunId, role: input.parkedRole, account: chosen },
          deps.accountsConfig!(),
        );
        if (outcome !== 'switched') {
          deps.debug(
            `[graph] usage-limit: account "${chosen}" not pinned for run ${input.signal.graphRunId} role "${input.parkedRole}" (${outcome})`,
          );
          void warn(graphAccountRefusalNotice(input.provider, input.parkedRole, chosen, outcome));
          continue;
        }
        deps.activity?.(input.signal.ticketId, graphAccountActivity(input.parkedRole, chosen, offered.active));
        resume(input.signal.ticketId, input.signal.graphRunId);
        return;
      }
      if (choice === RETRY_LABEL) {
        resume(input.signal.ticketId, input.signal.graphRunId);
        return;
      }
      // DISMISS_LABEL or a closed notification: the blocked banner keeps
      // Resume and Replan; the park is never lifted here.
      return;
    }
  };

  const binding: GraphUsageLimitBinding = {
    async onGraphUsageLimit(signal) {
      try {
        const store = deps.store();
        if (!store) {
          deps.debug('[graph] usage-limit: coordinator store is not wired, nothing parked');
          return;
        }
        const identity = graphRunProcessIdentity(store.db, signal.role, signal.runId);
        const provider = signal.provider ?? identity?.provider ?? null;
        if (provider === null) {
          deps.debug(
            `[graph] usage-limit: ${signal.role} run ${signal.runId} has no running process identity, nothing parked`,
          );
          return;
        }
        const model = identity?.model ?? null;
        const parkedRole = parkedGraphRole(signal.role, identity?.agentName ?? null);
        const result = await parkGraphUsageLimit(
          {
            store,
            transaction: deps.transaction,
            now: deps.now,
            debug: deps.debug,
            terminateSession,
          },
          {
            graphRunId: signal.graphRunId,
            role: signal.role,
            runId: signal.runId,
            provider,
            model,
            text: signal.text,
          },
        );
        // Another window won the park, or the run was already blocked: no
        // stage write, no refresh, and (critically) no second prompt.
        if (!result.parked) return;
        // The park is COMMITTED. Everything below is presentation: a
        // lock-contended stage write or a failed refresh must never turn the
        // committed park into a reported failure or swallow the one-shot
        // prompt.
        await writeStageBlock(store, signal);
        refreshQuietly(signal.ticketId);
        // A parallel node of the SAME stop parks and is terminated, but the
        // run's first park already asked the user — do not ask twice.
        if (!result.prompt) return;

        const ticket = getTicket(store, signal.ticketId);
        const ticketKey = ticket.key || String(signal.ticketId);
        await offer({
          signal,
          provider,
          model,
          parkedRole,
          label: `Graph ${signal.role} of ${ticketKey} hit the ${provider} usage limit`,
        });
      } catch (error) {
        deps.logError('karst: graph usage-limit park failed', error);
        toastError(`Karst could not park the graph ${signal.role} on its usage limit (${reasonText(error)}).`);
      } finally {
        refreshQuietly(signal.ticketId);
      }
    },
    onGraphHookUsageLimit(owner, text) {
      void binding.onGraphUsageLimit({
        ticketId: owner.ticketId,
        graphRunId: owner.graphRunId,
        runId: owner.runId,
        role: owner.role,
        provider: owner.provider,
        text,
      });
    },
  };
  return binding;
}
