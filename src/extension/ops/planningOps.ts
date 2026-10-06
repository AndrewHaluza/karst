import { mkdirSync } from 'node:fs';
import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import { resolveAdapter } from '../../agent/registry.js';
import { KARST_CLI_ENV } from '../../agent/cliEnv.js';
import {
  createPlanningSession,
  deletePlanningSession,
  getPlanningSession,
  listPlanningSessions,
  listPlanningTickets,
  setPlanningSessionStatus,
  type PlanningSession,
} from '../../store/planningSessions.js';
import {
  KARST_PLANNING_SESSION_ENV,
  PLANNING_OUTBOX_ENV,
  planningAddDirs,
  planningOutboxDir,
  planningPreamble,
  type PlanningManifest,
} from '../../planning/preamble.js';
import type { SessionTerminal, TerminalHost } from '../../ui/session.js';
import type { Notify } from './notify.js';

/**
 * Planning sessions: create, open, archive (vscode-free; `extension.ts` binds).
 *
 * A planning terminal is NOT a ticket session: it carries no `KARST_TICKET_ID`,
 * so the SessionManager, recovery and liveness sweeps never adopt it. Its live
 * terminal is tracked here, per window, by session id. A window reload keeps
 * the terminal but empties this map, so activation calls `adopt` with the
 * window's terminals to re-register the survivors (see `planningSessionIdOf`).
 */

/** Tab-name prefix; the session id in it is the last-resort reload identity. */
export const PLANNING_TERMINAL_PREFIX = 'Karst plan #';

/** A terminal already open in the window, as `adopt` sees it. */
export interface PlanningTerminalCandidate {
  name: string;
  /** Launch env — VS Code drops it on a reload, so usually absent then. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Launch cwd — survives a reload (the pty details carry it). */
  cwd?: string | undefined;
  /** The process already exited: a dead tab is never adopted. */
  exited?: boolean;
  terminal: SessionTerminal;
}

const POSITIVE_INT = /^[1-9]\d*$/;

/**
 * Which planning session a terminal was launched for: the env first (exact),
 * then the scratch cwd (what survives a reload), then the `#<id>` in the tab
 * name (an agent may retitle the tab, so it is only the fallback).
 */
export function planningSessionIdOf(
  c: PlanningTerminalCandidate,
  scratchDir: (sessionId: number) => string,
): number | undefined {
  const fromEnv = c.env?.[KARST_PLANNING_SESSION_ENV];
  if (typeof fromEnv === 'string' && POSITIVE_INT.test(fromEnv)) return Number(fromEnv);
  if (c.cwd) {
    const tail = c.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
    if (POSITIVE_INT.test(tail) && scratchDir(Number(tail)) === c.cwd) return Number(tail);
  }
  if (c.name.startsWith(PLANNING_TERMINAL_PREFIX)) {
    const id = /^(\d+):/.exec(c.name.slice(PLANNING_TERMINAL_PREFIX.length))?.[1];
    if (id && POSITIVE_INT.test(id)) return Number(id);
  }
  return undefined;
}

export interface PlanningOpsDeps {
  store: Store;
  projectId: () => number | undefined;
  manifest: () => PlanningManifest | undefined;
  /**
   * The session's own scratch directory (created if missing): the agent's cwd,
   * holding the outbox `draft propose` writes. Never a repository and never
   * under the registry's directory — under codex's sandbox the cwd is the
   * ONLY writable root.
   */
  scratchDir: (sessionId: number) => string;
  defaultAgent: () => { provider: AgentProvider; model: string | null };
  host: TerminalHost;
  /** The karst CLI entry. Only it reaches a planning launch — never the DB or manifest path. */
  cliEntry: () => string | undefined;
  notify: Notify;
  /**
   * Asked before EVERY launch on a core that cannot block edits (its
   * `readOnlyInteractive` surface is unsupported — agy). Absent = declined.
   */
  confirmUnsafeCore?: (core: AgentProvider) => Promise<boolean>;
  /** Called when the session list or a terminal's liveness changes (the sidebar re-pushes). */
  onChange?: () => void;
  debug?: (message: string) => void;
}

export interface PlanningListItem extends PlanningSession {
  ticketCount: number;
  live: boolean;
}

export interface PlanningOps {
  create(title: string): Promise<PlanningSession | undefined>;
  open(id: number): Promise<void>;
  archive(id: number): void;
  /** Back to `filed` when it produced tickets, else `active`. */
  unarchive(id: number): void;
  /** Re-register this window's surviving planning terminals (window reload). */
  adopt(terminals: readonly PlanningTerminalCandidate[]): void;
  list(): PlanningListItem[];
  isLive(id: number): boolean;
}

export function createPlanningOps(deps: PlanningOpsDeps): PlanningOps {
  const live = new Map<number, SessionTerminal>();
  const debug = (m: string): void => deps.debug?.(`[planning] ${m}`);

  function track(id: number, terminal: SessionTerminal): void {
    live.set(id, terminal);
    terminal.onDidClose(() => {
      if (live.get(id) === terminal) live.delete(id);
      debug(`terminal for ${id} closed`);
      deps.onChange?.();
    });
  }

  /** A core that cannot block edits launches only after the user acknowledges it, every time. */
  async function acknowledged(session: PlanningSession): Promise<boolean> {
    const core = session.core as AgentProvider;
    if (resolveAdapter(core).surfaces?.readOnlyInteractive.supported === true) return true;
    const ok = (await deps.confirmUnsafeCore?.(core)) ?? false;
    debug(`launch ${session.id}: ${core} cannot block edits — ${ok ? 'acknowledged' : 'declined'} by the user`);
    return ok;
  }

  /** Start the agent terminal. False (after a warning) when it could not. */
  async function launch(session: PlanningSession): Promise<boolean> {
    const manifest = deps.manifest();
    if (!manifest) {
      debug(`launch ${session.id} blocked: no manifest loaded`);
      deps.notify.warn('Karst: load a manifest before you start a planning session.');
      return false;
    }
    try {
      if (!(await acknowledged(session))) return false;
      const cliEntry = deps.cliEntry();
      const cwd = deps.scratchDir(session.id);
      const outbox = planningOutboxDir(cwd);
      mkdirSync(outbox, { recursive: true });
      const adapter = resolveAdapter(session.core as AgentProvider);
      const cmd = adapter.buildInteractiveCommand({
        cwd,
        readOnly: true,
        addDirs: planningAddDirs(manifest),
        initialPrompt: planningPreamble({ sessionId: session.id, title: session.title, manifest }),
        ...(session.model ? { model: session.model } : {}),
      });
      debug(`launch ${session.id}: ${session.core} ${cmd.command} (cwd ${cwd}, <prompt redacted>)`);
      const terminal = deps.host.createTerminal({
        name: `${PLANNING_TERMINAL_PREFIX}${session.id}: ${session.title}`,
        cwd,
        shellPath: cmd.command,
        shellArgs: cmd.args,
        // No KARST_DB / KARST_MANIFEST: the agent only proposes into its outbox.
        env: {
          ...cmd.env,
          ...(cliEntry ? { [KARST_CLI_ENV]: cliEntry } : {}),
          [PLANNING_OUTBOX_ENV]: outbox,
          [KARST_PLANNING_SESSION_ENV]: String(session.id),
        },
      });
      track(session.id, terminal);
      terminal.show();
    } catch (error) {
      debug(`launch ${session.id} failed (${session.core}): ${error instanceof Error ? error.message : String(error)}`);
      deps.notify.warn(`Karst: could not start the planning agent (${session.core}). See the Karst output for details.`);
      return false;
    }
    deps.onChange?.();
    return true;
  }

  return {
    async create(title) {
      const projectId = deps.projectId();
      if (projectId === undefined) {
        debug('create blocked: no active project');
        deps.notify.warn('Karst: open a project before you start a planning session.');
        return undefined;
      }
      const agent = deps.defaultAgent();
      const session = createPlanningSession(deps.store, {
        projectId,
        title,
        core: agent.provider,
        model: agent.model,
      });
      debug(`created ${session.id} (${session.core})`);
      if (await launch(session)) return session;
      // Never leave an active session nobody can see started.
      deletePlanningSession(deps.store, session.id);
      debug(`create ${session.id} rolled back: launch failed`);
      return undefined;
    },

    async open(id) {
      const existing = live.get(id);
      if (existing) {
        debug(`open ${id}: focusing live terminal`);
        existing.show();
        return;
      }
      const session = getPlanningSession(deps.store, id);
      if (!session || session.status === 'archived') {
        debug(`open ${id} blocked: ${session ? 'archived' : 'unknown'}`);
        deps.notify.warn('Karst: that planning session no longer exists.');
        return;
      }
      await launch(session);
    },

    archive(id) {
      live.get(id)?.dispose();
      live.delete(id);
      setPlanningSessionStatus(deps.store, id, 'archived');
      debug(`archived ${id}`);
      deps.onChange?.();
    },

    unarchive(id) {
      const session = getPlanningSession(deps.store, id);
      if (!session) {
        debug(`unarchive ${id} blocked: unknown`);
        deps.notify.warn('Karst: that planning session no longer exists.');
        return;
      }
      const status = listPlanningTickets(deps.store, id).length > 0 ? 'filed' : 'active';
      setPlanningSessionStatus(deps.store, id, status);
      debug(`unarchived ${id} -> ${status}`);
      deps.onChange?.();
    },

    adopt(terminals) {
      const projectId = deps.projectId();
      let adopted = 0;
      for (const c of terminals) {
        if (c.exited) continue;
        const id = planningSessionIdOf(c, deps.scratchDir);
        if (id === undefined || live.has(id)) continue;
        const session = getPlanningSession(deps.store, id);
        if (!session || session.status === 'archived' || session.projectId !== projectId) {
          debug(`adopt skipped terminal for ${id}: ${session ? `${session.status}/project ${session.projectId}` : 'unknown'}`);
          continue;
        }
        track(id, c.terminal);
        adopted++;
      }
      debug(`adopted ${adopted} planning terminal(s)`);
      if (adopted > 0) deps.onChange?.();
    },

    isLive: (id) => live.has(id),

    list() {
      const projectId = deps.projectId();
      if (projectId === undefined) return [];
      return listPlanningSessions(deps.store, projectId).map((s) => ({
        ...s,
        ticketCount: listPlanningTickets(deps.store, s.id).length,
        live: live.has(s.id),
      }));
    },
  };
}
