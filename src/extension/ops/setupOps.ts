import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentProvider } from '../../manifest/types.js';
import { resolveAdapter } from '../../agent/registry.js';
import { KARST_INSTRUCTIONS_ENV, sessionCliEnv } from '../../agent/cliEnv.js';
import { writeSessionInstructions } from '../../agent/instructions.js';
import { measureSeed } from '../../agent/seed.js';
import { SETUP_OUTBOX_ENV } from '../../setup/proposal.js';
import {
  KARST_SETUP_SESSION_ENV,
  setupAddDirs,
  setupInstructions,
  type SetupManifest,
} from '../../setup/instructions.js';
import { setupOutboxDir } from '../../setup/outbox.js';
import type { SessionTerminal, TerminalHost } from '../../ui/session.js';
import { KARST_TERMINAL_ICON_ID } from '../../ui/terminalNaming.js';
import type { Notify } from './notify.js';

/**
 * Onboarding setup sessions: launch a read-only agent that discovers the
 * workspace and proposes a manifest + consented repo changes.
 *
 * Like a planning session, a setup terminal is NOT a ticket session: it carries
 * no `KARST_TICKET_ID`, so SessionManager/recovery/liveness never adopt it. Its
 * scratch dir holds the outbox the CLI writes proposals into; the agent's cwd is
 * the scratch (the only writable root under codex's sandbox), and the workspace
 * is added as a read-only dir so the agent can inspect it without editing it.
 *
 * `readOnly: true` is passed to the adapter, and a core that cannot block edits
 * (agy) is acknowledged by the user before every launch — exactly the planning
 * posture, because this session must not change tracked files either.
 */

export const SETUP_TERMINAL_PREFIX = 'S';

export interface SetupOpsDeps {
  manifest: () => SetupManifest | undefined;
  /** The workspace root, added as a read-only dir so the agent can inspect it. */
  workspaceRoot: () => string | undefined;
  defaultAgent: () => { provider: AgentProvider; model: string | null };
  /** The session's own scratch directory (created if missing). */
  scratchDir: (sessionId: string) => string;
  host: TerminalHost;
  cliEntry: () => string | undefined;
  /** The registry DB path, exported so the session can run `setup verify`. */
  dbPath: string;
  /** The workspace manifest path, exported for `setup verify`. */
  manifestPath: () => string | undefined;
  notify: Notify;
  /** Asked before EVERY launch on a core that cannot block edits. Absent = declined. */
  confirmUnsafeCore?: (core: AgentProvider) => Promise<boolean>;
  /** Injectable id source for deterministic tests. */
  nextId?: () => string;
  debug?: (message: string) => void;
}

export interface SetupOps {
  /** Launch a setup session. False (after a warning) when it could not start. */
  create(): Promise<boolean>;
  /** Whether a setup terminal for this id is currently tracked. */
  isLive(id: string): boolean;
}

export function createSetupOps(deps: SetupOpsDeps): SetupOps {
  const live = new Map<string, SessionTerminal>();
  const debug = (m: string): void => deps.debug?.(`[setup] ${m}`);

  async function acknowledged(core: AgentProvider): Promise<boolean> {
    if (resolveAdapter(core).surfaces?.readOnlyInteractive.supported === true) return true;
    const ok = (await deps.confirmUnsafeCore?.(core)) ?? false;
    debug(`launch: ${core} cannot block edits — ${ok ? 'acknowledged' : 'declined'} by the user`);
    return ok;
  }

  return {
    async create() {
      const core = deps.defaultAgent().provider;
      if (!(await acknowledged(core))) return false;
      const id = (deps.nextId ?? (() => randomUUID().slice(0, 8)))();
      const cwd = deps.scratchDir(id);
      const outbox = setupOutboxDir(cwd);
      try {
        mkdirSync(outbox, { recursive: true });
        const manifest = deps.manifest();
        const instructions = writeSessionInstructions(cwd, setupInstructions({ title: 'Workspace setup', manifest }));
        const adapter = resolveAdapter(core);
        const model = deps.defaultAgent().model;
        const root = deps.workspaceRoot();
        const addDirs = root ? [root, ...setupAddDirs(manifest)] : setupAddDirs(manifest);
        const cmd = adapter.buildInteractiveCommand({
          cwd,
          readOnly: true,
          addDirs,
          ...(adapter.instructions && adapter.instructions.interactive !== 'n/a' ? { instructions } : {}),
          ...(model ? { model } : {}),
        });
        const metrics = measureSeed('', undefined, instructions);
        debug(
          `launch ${id}: ${core} ${cmd.command} (cwd ${cwd}, instructions ${metrics.instructionsChars ?? 0}c ` +
            `#${metrics.instructionsHash ?? 'none'} via ${cmd.instructionsChannel ?? 'n/a'})`,
        );
        const cliEntry = deps.cliEntry();
        const cliEnv = sessionCliEnv({
          cliEntry,
          dbPath: deps.dbPath,
          manifestPath: deps.manifestPath(),
        });
        const terminal = deps.host.createTerminal({
          name: `${SETUP_TERMINAL_PREFIX}${id} Workspace setup`,
          cwd,
          shellPath: cmd.command,
          shellArgs: cmd.args,
          iconPath: KARST_TERMINAL_ICON_ID,
          // KARST_DB / KARST_MANIFEST are exported so the session can run
          // `setup verify`; the agent still only proposes into its outbox.
          env: {
            ...cmd.env,
            ...cliEnv,
            [KARST_INSTRUCTIONS_ENV]: instructions.path,
            [SETUP_OUTBOX_ENV]: outbox,
            [KARST_SETUP_SESSION_ENV]: id,
          },
        });
        live.set(id, terminal);
        terminal.onDidClose(() => {
          if (live.get(id) === terminal) live.delete(id);
          debug(`terminal for ${id} closed`);
        });
        terminal.show();
        return true;
      } catch (error) {
        debug(`launch ${id} failed (${core}): ${error instanceof Error ? error.message : String(error)}`);
        deps.notify.warn(`Karst: could not start the setup agent (${core}). See the Karst output for details.`);
        return false;
      }
    },
    isLive: (id) => live.has(id),
  };
}
