import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import { resolveAdapter } from '../../agent/registry.js';
import { sessionCliEnv } from '../../agent/cliEnv.js';
import {
  createPlanningSession,
  getPlanningSession,
  listPlanningSessions,
  listPlanningTickets,
  setPlanningSessionStatus,
  type PlanningSession,
} from '../../store/planningSessions.js';
import {
  KARST_PLANNING_SESSION_ENV,
  planningAddDirs,
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
 * terminal is tracked here, per window, by session id. After a window reload
 * "open" launches a fresh read-only agent with the same preamble.
 */

export interface PlanningOpsDeps {
  store: Store;
  projectId: () => number | undefined;
  manifest: () => PlanningManifest | undefined;
  /** The directory the agent starts in (the manifest's directory). */
  stackRoot: () => string | undefined;
  defaultAgent: () => { provider: AgentProvider; model: string | null };
  host: TerminalHost;
  cli: { cliEntry?: string; dbPath?: string; manifestPath?: string };
  notify: Notify;
  debug?: (message: string) => void;
}

export interface PlanningListItem extends PlanningSession {
  ticketCount: number;
  live: boolean;
}

export interface PlanningOps {
  create(title: string): PlanningSession | undefined;
  open(id: number): void;
  archive(id: number): void;
  list(): PlanningListItem[];
}

export function createPlanningOps(deps: PlanningOpsDeps): PlanningOps {
  const live = new Map<number, SessionTerminal>();
  const debug = (m: string): void => deps.debug?.(`[planning] ${m}`);

  function launch(session: PlanningSession): void {
    const manifest = deps.manifest();
    const cwd = deps.stackRoot();
    if (!manifest || !cwd) {
      debug(`launch ${session.id} blocked: no manifest loaded`);
      deps.notify.warn('Karst: load a manifest before you start a planning session.');
      return;
    }
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
      name: `Karst plan: ${session.title}`,
      cwd,
      shellPath: cmd.command,
      shellArgs: cmd.args,
      env: {
        ...cmd.env,
        ...sessionCliEnv(deps.cli, deps.debug),
        [KARST_PLANNING_SESSION_ENV]: String(session.id),
      },
    });
    live.set(session.id, terminal);
    terminal.onDidClose(() => {
      if (live.get(session.id) === terminal) live.delete(session.id);
      debug(`terminal for ${session.id} closed`);
    });
    terminal.show();
  }

  return {
    create(title) {
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
      launch(session);
      return session;
    },

    open(id) {
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
      launch(session);
    },

    archive(id) {
      live.get(id)?.dispose();
      live.delete(id);
      setPlanningSessionStatus(deps.store, id, 'archived');
      debug(`archived ${id}`);
    },

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
