import * as vscode from 'vscode';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

import { openStore, type Store } from './store/db.js';
import { SidebarViewManager } from './ui/sidebar/panel.js';
import { makeSidebarViewHost, SIDEBAR_VIEW_ID } from './ui/sidebar/host.js';
import { FACETS, facetCounts } from './ui/sidebar/facets.js';
import { DashboardManager, type DashboardPanel, type PanelHost } from './ui/dashboard/panel.js';
import type { DashboardActions } from './ui/dashboard/messages.js';
import {
  SessionManager,
  type TerminalHost,
  type SessionTerminal,
} from './ui/session.js';
import { resolveAdapter } from './agent/registry.js';
import { buildSessionSeed } from './agent/seed.js';
import { buildTicketContext, renderTicketContext } from './context/ticketContext.js';
import { resolveModel } from './agent/models.js';
import { composeContextCommand } from './cli/context.js';
import {
  buildWorkflowInvocation,
  renderWorkflowCommand,
  KARST_PLUGIN_NAME,
  orchestratorCommandBasename,
} from './agent/workflowCommand.js';
import { startHookEndpoint, type HookEndpoint } from './hooks/endpoint.js';
import { writeHookSettings } from './agent/settings.js';
import { listWorktreesByTicket, serverAddress } from './store/dashboard.js';
import { stopServer } from './runtime/supervisor.js';
import { loadManifest, type Manifest } from './manifest/load.js';
import type { PathContext } from './ui/dashboard/state.js';
import { writeServiceSignals } from './manifest/write.js';
import {
  resolveManifest,
  manifestPathOrThrow,
  approachesDirOrThrow,
  agentsDirOrThrow,
  emptyManifest,
} from './extension/manifestResolve.js';
import { installApproach, type RunCommand } from './approaches/fetch.js';
import { resolveApproachPrompt } from './approaches/resolve.js';
import type { ApproachDef } from './manifest/types.js';
import {
  listInstalled,
  readApproachPackage,
  uninstallApproach,
  readArtifactBody,
  listArtifacts,
  type ApproachPackage,
} from './approaches/pkg.js';
import { readAgentFile, writeAgentFile, removeAgentFile } from './agents/pkg.js';
import { buildAgentPool, type PoolAgent } from './agents/pool.js';
import { spinTicket, SpinCancelledError } from './runtime/spin.js';
import { confirmScope } from './workflow/stages/scope.js';
import { transition } from './workflow/machine.js';
import {
  getTicket,
  ticketLabel,
  listTickets,
  listArchivedTickets,
  archiveTicket,
  unarchiveTicket,
  deleteTicket,
} from './store/tickets.js';
import { OnboardingManager } from './ui/onboarding/panel.js';
import { buildOnboardingActions } from './ui/onboarding/actions.js';
import { makeOnboardingPanelHost } from './ui/onboarding/host.js';
import {
  makeTokenProvider,
  setToken,
  clearToken,
  hasToken,
} from './extension/secrets.js';
import { makeTicketingProvider } from './integrations/ticketing.js';
import { SettingsManager, type LoadedManifest } from './ui/settings/panel.js';
import { buildSettingsActions } from './ui/settings/actions.js';
import type { SettingsState } from './ui/settings/state.js';
import { makeSettingsPanelHost } from './ui/settings/host.js';
import { writeManifest } from './manifest/write.js';

/**
 * Extension activation adapter — the host seam (§2.6). Everything below the UI
 * is host-agnostic and unit-tested; this file is the ONE place real `vscode`
 * APIs are bound to those interfaces. It holds no business logic — it wires
 * concrete `vscode` panels/terminals/tree + the hook endpoint into the tested
 * managers, so the extension is a thin shell over covered code.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

let store: Store | undefined;
let endpoint: HookEndpoint | undefined;

/** Minimal starter body for a brand-new agent file created from Settings. */
function agentStarterTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\nDescribe what this subagent does.\n`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // globalStorageUri's directory isn't created for us — SQLite won't make the
  // parent dir, so ensure it exists before opening the store (first activation).
  const storageDir = context.globalStorageUri.fsPath;
  mkdirSync(storageDir, { recursive: true });
  const dbPath = join(storageDir, 'karst.db');
  store = openStore(dbPath);
  const localStore = store;

  // Sidebar ticket list — an HTML webview view (replaces the native tree). The
  // manager holds facet/filter + re-pushes state; its action factory maps webview
  // messages to the existing karst.* commands (executeCommand passthrough) so the
  // command handlers stay the single source of behavior.
  const provider = new SidebarViewManager(localStore, (mgr) => ({
    setFacet: (facet) => mgr.setFacet(facet),
    setFilter: (query) => mgr.setFilter(query),
    refresh: () => mgr.refresh(),
    requestState: () => mgr.refresh(),
    create: () => void vscode.commands.executeCommand('karst.createTicket'),
    openSettings: () => void vscode.commands.executeCommand('karst.openSettings'),
    openDashboard: (id) => void vscode.commands.executeCommand('karst.openDashboard', id),
    spin: (id) => void vscode.commands.executeCommand('karst.spinTicket', id),
    openSession: (id) => void vscode.commands.executeCommand('karst.openSession', id),
    edit: (id) => void vscode.commands.executeCommand('karst.editTicket', id),
    archive: (id) => void vscode.commands.executeCommand('karst.archiveTicket', id),
    unarchive: (id) => void vscode.commands.executeCommand('karst.unarchiveTicket', id),
    delete: (id) => void vscode.commands.executeCommand('karst.deleteTicket', id),
  }), () => worktreePathContext(currentManifest), () => currentManifest?.ticketLabelTemplate);
  const { host: sidebarHost, provider: sidebarProvider } = makeSidebarViewHost(context);
  provider.bind(sidebarHost);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider),
  );

  const settingsDir = context.globalStorageUri.fsPath;
  // One adapter instance, shared by the session manager and the openSession
  // handler's approach materialization (the seam that turns a neutral package
  // into agent-specific launch args).
  // No manifest is resolved yet at this point in activation; only 'claude' is
  // functional today (see agent/registry.ts) so the fallback is always correct.
  const agentAdapter = resolveAdapter('claude');
  const sessions = new SessionManager(
    agentAdapter,
    makeTerminalHost(),
    () => writeHookSettings(endpoint?.port ?? 0, settingsDir),
  );

  // The manifest an open onboarding/edit uses; set when a command resolves it.
  let currentManifest: Manifest | undefined;
  let currentManifestPath: string | undefined;

  // Re-read the manifest from disk into the live copy. Shared by onboarding
  // (after a signal writeback) and settings (after a save) so both surfaces
  // observe the same reload behavior from one implementation.
  const reloadManifest = (): void => {
    if (currentManifestPath) currentManifest = loadManifest(currentManifestPath);
  };

  // Load the manifest for the settings page. Unlike resolveManifest (which gates
  // on invalid), this ALWAYS returns something to edit: a valid parse, or a raw
  // best-effort manifest plus the error so the page opens on a broken file.
  const loadSettingsState = (): LoadedManifest => {
    const path = manifestPathOrThrow();
    try {
      return { manifest: loadManifest(path), error: null };
    } catch (e) {
      return {
        manifest: currentManifest ?? emptyManifest(),
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };

  // Real shell-out for npm-source approach installs: run the source's command
  // via a shell (it's a full command string like "npx get-shit-done init"),
  // mirroring the spawnSync shape in src/runtime/worktree.ts:202-213.
  const realRunCommand: RunCommand = (cmd, cwd) => {
    const r = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true });
    return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };

  // Bound installer for the approaches picker (Phase E). `approachesDirOrThrow`
  // is resolved at call time, not here, so it reflects the current
  // workspace/setting and doesn't throw at activation when there's no folder.
  const installApproachHere = (def: ApproachDef): Promise<ApproachPackage> =>
    installApproach(def, {
      fetchFn: fetch,
      baseDir: approachesDirOrThrow(),
      runCommand: realRunCommand,
    });
  // Ids of approach packages already installed on disk, for the onboarding
  // state (Task E1). `approachesDirOrThrow` throws with no workspace folder;
  // guarded to "nothing installed" so onboarding still opens in that case.
  const listInstalledApproachIds = (): string[] => {
    try {
      return listInstalled(approachesDirOrThrow()).map((p) => p.id);
    } catch {
      return [];
    }
  };

  // Selectable single-subagent pool for the onboarding picker (§ single-
  // subagent selection): local agent files ∪ agent-kind artifacts of
  // installed+enabled approaches. Guarded the same way as
  // `listInstalledApproachIds` — no workspace folder yet at activation, or a
  // transient fs error, degrades to "no agents" rather than throwing.
  const listAgents = (): PoolAgent[] => {
    try {
      return buildAgentPool({
        agentsDir: agentsDirOrThrow(),
        approachesDir: approachesDirOrThrow(),
        approaches: currentManifest?.approaches ?? [],
        agentsMeta: currentManifest?.agents ?? {},
      });
    } catch {
      return [];
    }
  };

  // Onboarding page: create + edit tickets on one persistent surface. The
  // manifest is read fresh per-open (getter) so a signal write is reflected
  // immediately. The ClickUp provider + agent adapter are wired with the secure
  // token seam; the manifest/path are read at call time (resolved on open).
  const onboarding = new OnboardingManager(
    localStore,
    () => currentManifest ?? emptyManifest(),
    makeOnboardingPanelHost(context),
    buildOnboardingActions({
      store: localStore,
      // These read `currentManifest`/`currentManifestPath` at call time so a
      // manifest resolved on open is available to fetch/suggest/save.
      get manifest() {
        return currentManifest ?? emptyManifest();
      },
      get manifestPath() {
        return currentManifestPath ?? '';
      },
      // Read `ticketing` fresh so a provider/teamId change saved from settings
      // applies without a reload (same getter pattern as `manifest` above).
      get provider() {
        return makeTicketingProvider(
          (currentManifest ?? emptyManifest()).ticketing,
          fetch,
          makeTokenProvider(context),
        );
      },
      // Read fresh so a provider choice saved from settings takes effect on
      // the next onboarding action, mirroring `get provider()` above — this
      // object is built once at activation, so a static property would be
      // permanently stuck on the fallback ('claude') read at that moment.
      get adapter() {
        return resolveAdapter((currentManifest ?? emptyManifest()).agentProvider ?? 'claude');
      },
      onChange: () => provider.refresh(),
      // Finish handoff: scope the ticket's selected repos (worktrees, no
      // servers) and open the agent session seeded with its chosen approach.
      // Servers stay deferred — they come up only when a stage needs to verify.
      startTicket: async (ticketId: number) => {
        const t = getTicket(localStore, ticketId);
        const hot = t.selectedRepos;
        if (hot.length === 0) return; // nothing scoped → leave the ticket pending
        const manifest = currentManifest ?? emptyManifest();
        try {
          confirmScope(localStore, manifest, ticketId, hot);
          // Scope is complete the moment its worktrees exist (scope has only a
          // pass edge → impl; it is not a gate). Pass it so the ticket advances
          // to impl running — the agent session opens in the impl worktree.
          transition(localStore, ticketId, 'scope', { kind: 'passed' });
          provider.refresh();
          // Await so a launch failure (missing worktree, terminal spawn throw)
          // surfaces through the catch below instead of a silent stall with the
          // ticket already advanced to impl.
          await vscode.commands.executeCommand('karst.openSession', ticketId);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Could not start ticket: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      writeSignals: writeServiceSignals,
      // Re-read the manifest from disk after a signal writeback so the panel's
      // manifest getter (currentManifest) reflects the saved signals — the gate
      // clears and the repo row shows them on the next pushState.
      reloadManifest,
      listInstalledIds: listInstalledApproachIds,
    }),
    listInstalledApproachIds,
    listAgents,
    // Locks the model/effort picker while a session terminal is live (§ B1).
    (ticketId) => sessions.isOpen(ticketId),
  );

  // Full agent-pool rows for the Settings "Agents" tab. Unlike `listAgents`
  // (used for the onboarding solo-agent picker, which drops disabled agents),
  // this calls `buildAgentPool` WITHOUT `agentsMeta` so disabled agents stay
  // visible with `enabled:false` — the whole point of the tab is re-enabling
  // them. `body` is the file contents for a local file (so it's editable);
  // an approach artifact's body isn't surfaced here (installed, not edited).
  // Same degrade-to-[] guard as `listAgents` (no workspace folder yet, etc).
  const listAgentRows = (): SettingsState['agents'] => {
    try {
      const pool = buildAgentPool({
        agentsDir: agentsDirOrThrow(),
        approachesDir: approachesDirOrThrow(),
        approaches: currentManifest?.approaches ?? [],
      });
      const agentsMeta = currentManifest?.agents ?? {};
      return pool.map((a) => ({
        name: a.name,
        source: a.source,
        ...(a.approachId !== undefined ? { approachId: a.approachId } : {}),
        enabled: agentsMeta[a.name]?.enabled !== false,
        body: a.source === 'file' ? (readAgentFile(agentsDirOrThrow(), a.name)?.body ?? null) : null,
      }));
    } catch {
      return [];
    }
  };

  // Slash commands each installed approach package exposes, for the Settings
  // "Commands" tab: the generated `/karst:<id>` orchestrator when the package
  // declares a `workflow`, plus `/<id>:<basename>` for every `command`-kind
  // artifact. Same guard pattern — any read failure degrades to `{}`.
  const listApproachCommands = (): Record<string, string[]> => {
    try {
      const dir = approachesDirOrThrow();
      const result: Record<string, string[]> = {};
      for (const id of listInstalledApproachIds()) {
        const pkg = readApproachPackage(dir, id);
        if (!pkg) continue;
        // Slash-form the user actually types: a plugin named `<id>` exposes each
        // command file as `/<id>:<basename>` — the generated orchestrator is
        // `/karst:<id>`, native fetched commands are `/<id>:<their-basename>`.
        const commandNames = listArtifacts(pkg, 'command').map((a) => `/${id}:${basename(a.relPath, '.md')}`);
        result[id] = [
          ...(pkg.workflow?.length ? [`/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(id)}`] : []),
          ...commandNames,
        ];
      }
      return result;
    } catch {
      return {};
    }
  };

  // Settings page: edit the manifest (host, ports, services, agents, ...) on a
  // persistent surface. Opens even on an invalid manifest so a broken file can
  // be fixed from the UI; save re-validates before touching disk.
  const settings = new SettingsManager(
    loadSettingsState,
    () => manifestPathOrThrow(),
    makeSettingsPanelHost(context),
    buildSettingsActions({
      writeManifest,
      reloadManifest,
      onChange: () => {
        provider.refresh();
        // Re-push any open dashboards so worktree-path display etc. reflect edits.
      },
      loadState: loadSettingsState,
      installApproach: installApproachHere,
      uninstallApproach: (id: string): boolean => {
        try {
          return uninstallApproach(approachesDirOrThrow(), id);
        } catch {
          return false;
        }
      },
      listInstalledIds: listInstalledApproachIds,
      // Token entered host-side via a password input box; the raw token never
      // crosses back into the webview — only the boolean "configured" flag does.
      setToken: async (): Promise<boolean> => {
        const entered = await vscode.window.showInputBox({
          prompt: 'ClickUp API token (stored securely in your OS keychain)',
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? null : 'Token is required'),
        });
        if (!entered) return false;
        await setToken(context, entered);
        return true;
      },
      clearToken: (): Promise<void> => clearToken(context),
      hasToken: (): Promise<boolean> => hasToken(context),
      saveAgentFile: (name: string, body: string): void =>
        writeAgentFile(agentsDirOrThrow(), name, body),
      deleteAgent: (name: string): void => removeAgentFile(agentsDirOrThrow(), name),
      createAgent: (name: string): void =>
        writeAgentFile(agentsDirOrThrow(), name, agentStarterTemplate(name)),
      listAgentRows,
      listApproachCommands,
      readApproachCommandBody: (approachId: string, command: string): string => {
        const dir = approachesDirOrThrow();
        const pkg = readApproachPackage(dir, approachId);
        if (!pkg) throw new Error(`Approach "${approachId}" is not installed.`);
        // Generated orchestrator: /karst:<id> — render from the stored workflow.
        if (command === `/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(approachId)}`) {
          if (!pkg.workflow?.length) throw new Error(`Approach "${approachId}" has no workflow.`);
          return renderWorkflowCommand({ id: pkg.id, label: pkg.label, phases: pkg.workflow });
        }
        // Native command: /<id>:<name> — read commands/<name>.md from disk.
        const name = command.replace(new RegExp(`^/${approachId}:`), '');
        const art = listArtifacts(pkg, 'command').find((a) => basename(a.relPath, '.md') === name);
        if (!art) throw new Error(`No command "${command}" in approach "${approachId}".`);
        return readFileSync(join(dir, approachId, art.relPath), 'utf8');
      },
    }),
    listInstalledApproachIds,
    () => hasToken(context),
    listAgentRows,
    listApproachCommands,
  );

  const dashboard = new DashboardManager(
    localStore,
    makePanelHost(context),
    (ticketId) =>
      makeDashboardActions(localStore, ticketId, () => onboarding.openEdit(ticketId), () => {
        provider.refresh();
        dashboard.pushState(ticketId);
      }),
    () => worktreePathContext(currentManifest),
    () => currentManifest?.ticketLabelTemplate,
    // Live ticketing config so the dashboard links to the source board (§ C3).
    () => currentManifest?.ticketing,
  );

  // The hook channel fans liveness/needs-you out to the sidebar + any open
  // dashboard, so a waiting agent turns amber without opening its terminal.
  endpoint = await startHookEndpoint(localStore, 0, (ticketId) => {
    provider.refresh();
    dashboard.pushState(ticketId);
  });

  // Shared entry: resolve the manifest, remember it for onboarding actions, and
  // open the create-mode page. Used by both createTicket and openOnboarding.
  const openOnboardingCreate = async (): Promise<void> => {
    const manifest = await resolveManifest();
    if (!manifest) return; // no folder / scaffolded / invalid — message shown
    currentManifest = manifest;
    currentManifestPath = manifestPathOrThrow();
    onboarding.openCreate();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('karst.openDashboard', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      dashboard.openDashboard(ticketId);
    }),
    vscode.commands.registerCommand('karst.openSession', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      const wt = listWorktreesByTicket(localStore, ticketId)[0];
      if (!wt) {
        void vscode.window.showWarningMessage(`Ticket #${ticketId} has no worktree yet — scope it first.`);
        return;
      }
      const t = getTicket(localStore, ticketId);

      // Resolve the approach's method prompt (its entrypoint), if one resolves.
      // Any failure (no folder, no package, bad id) → no method, ticket context
      // alone. Built-in approaches (direct, single-subagent) have no entrypoint.
      let approachPrompt: string | null = null;
      try {
        const approaches = currentManifest?.approaches ?? [];
        approachPrompt = resolveApproachPrompt(approachesDirOrThrow(), approaches, t.approach);
      } catch {
        approachPrompt = null;
      }

      // Read the ticket's approach package ONCE — its `workflow` drives both the
      // seed invocation and the materialize call below, so both always agree on
      // what the generated `/karst:<id>` command looks like. Any read failure
      // (no folder, not installed) degrades to no package, not a thrown error.
      let pkg: ReturnType<typeof readApproachPackage> = null;
      try {
        pkg = t.approach ? readApproachPackage(approachesDirOrThrow(), t.approach) : null;
      } catch {
        pkg = null;
      }

      // A workflow-bearing approach gets an explicit `/karst:<id> <ticket-key>`
      // invocation as the seed's first line, so the generated command (written by
      // materializeApproach below under the sibling `karst` plugin) actually gets
      // invoked with the ticket key. `buildWorkflowInvocation` is the single source
      // of truth for the command name, shared with the materializer so they can't drift.
      const invocation =
        pkg?.workflow?.length && t.approach
          ? buildWorkflowInvocation(t.approach, t.key ?? '')
          : null;

      // For a single-subagent ticket with a chosen agent, resolve its body (a
      // local agent file OR an approach artifact, matching the pool entry's
      // `source`) so it can be materialized into the launch plugin and named in
      // the delegation instruction below. Any resolution failure degrades to no
      // solo agent — the session still opens, just without the plugin/delegation.
      let soloAgent: { name: string; body: string } | undefined;
      if (t.approach === 'single-subagent' && t.agent) {
        try {
          const pool = listAgents();
          const chosen = pool.find((a) => a.name === t.agent);
          if (chosen) {
            const body =
              chosen.source === 'file'
                ? (readAgentFile(agentsDirOrThrow(), chosen.name)?.body ?? null)
                : readArtifactBody(approachesDirOrThrow(), chosen.approachId!, chosen.relPath!);
            if (body) soloAgent = { name: chosen.name, body };
          }
        } catch {
          soloAgent = undefined;
        }
      }

      // ALWAYS seed the session with the ticket's own context (key, title,
      // description, fetched brief, repos), then the approach method if any — so
      // even a built-in "direct" approach opens with full context, not a dull
      // empty session. A built-in single-subagent has no method prompt of its
      // own, so a resolved solo agent contributes a delegation instruction
      // instead. undefined only when there's genuinely nothing to say.
      const delegation = soloAgent
        ? `Delegate this ticket to the \`${soloAgent.name}\` subagent and oversee it to completion.`
        : null;
      // Aggregate the ticket's full implementation context (prompt/brief/repos
      // plus live worktrees/branches/services/PRs) into markdown and seed it —
      // in-process, no CLI round-trip (the extension already holds the data).
      const ticketContextMd = renderTicketContext(
        buildTicketContext(localStore, currentManifest, ticketId),
      );
      const initialPrompt = buildSessionSeed(ticketContextMd, approachPrompt ?? delegation, invocation);

      // Materialize the ticket's approach package (and/or its chosen solo agent)
      // into agent-specific launch args (e.g. Claude's `--plugin-dir`) so its
      // agents/skills/commands are actually available in the session — not just
      // the entrypoint prompt. `matPkg` falls back to a synthetic minimal package
      // when there's a solo agent but no installed package (single-subagent is
      // built-in, never installed) — the adapter still needs an id/label to build
      // the plugin dir. Any failure degrades gracefully to no extras (still a
      // valid session).
      let extraArgs: string[] | undefined;
      try {
        const matPkg = pkg ?? (soloAgent ? { id: t.approach!, label: t.approach! } : null);
        if (matPkg && agentAdapter.materializeApproach) {
          const materialized = agentAdapter.materializeApproach({
            pkg: matPkg,
            baseDir: approachesDirOrThrow(),
            sessionDir: wt.path,
            soloAgent,
            cliContextPrefix: buildCliContextPrefix(context, dbPath),
          });
          extraArgs = materialized.extraArgs.length > 0 ? materialized.extraArgs : undefined;
        }
      } catch {
        extraArgs = undefined;
      }

      // A SOURCED approach (git/npm) that produced neither a method prompt NOR
      // materialized artifacts is broken (dangling entrypoint / package missing)
      // — warn so it isn't mistaken for the approach's method being applied. The
      // session still opens with ticket context; only the approach method is
      // missing. A BUILT-IN approach (no source) legitimately has no method —
      // never warn there.
      const approachDef = (currentManifest?.approaches ?? []).find((a) => a.id === t.approach);
      const approachIsSourced = approachDef?.source !== undefined;
      if (t.approach && approachIsSourced && approachPrompt === null && extraArgs === undefined) {
        void vscode.window.showWarningMessage(
          `Approach "${t.approach}" produced no method prompt or loadable artifacts — ` +
            `opening with ticket context only. Check the approach's entrypoint in the manifest and reinstall it.`,
        );
      }

      // Resolve the launch model: the ticket's own model wins, else the manifest
      // default, else undefined (let the agent CLI pick). Threaded as `--model`.
      const model = resolveModel(t.model, currentManifest?.defaultModel);

      sessions.openSession(
        ticketId,
        wt.path,
        { key: t.key, title: t.title },
        initialPrompt,
        extraArgs,
        model,
      );
    }),
    vscode.commands.registerCommand('karst.spinTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;

      const manifest = await resolveManifest();
      if (!manifest) return; // no folder / scaffolded / invalid — message already shown

      // Ticket label (key — title) for all the spin chrome, not the raw id.
      let label: string;
      try {
        label = ticketLabel(getTicket(localStore, ticketId), manifest.ticketLabelTemplate);
      } catch {
        void vscode.window.showErrorMessage(`Ticket #${ticketId} not found.`);
        return;
      }

      // Pre-select all hot services on first spin; on later spins default to the
      // set the user last chose for THIS ticket (workspace-scoped memory). A
      // service removed from the manifest since then simply drops out.
      const serviceNames = Object.keys(manifest.services);
      const memKey = `karst.spin.services.${ticketId}`;
      const remembered = context.workspaceState.get<string[]>(memKey);
      const items = serviceNames.map((name) => ({
        label: name,
        picked: remembered ? remembered.includes(name) : true,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: `Spin ${label} — select hot services`,
      });
      if (!picked || picked.length === 0) return; // cancelled or empty
      const hot = picked.map((i) => i.label);

      // Remember this choice so the next spin of this ticket pre-selects it.
      await context.workspaceState.update(memKey, hot);

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Spinning ${label}…`,
            cancellable: true,
          },
          (_progress, token) => {
            // Bridge VS Code's CancellationToken to a standard AbortSignal that
            // threads down into the health wait + child processes.
            const ctrl = new AbortController();
            token.onCancellationRequested(() => ctrl.abort());
            return spinTicket(localStore, manifest, ticketId, hot, { signal: ctrl.signal });
          },
        );
        provider.refresh();
        dashboard.pushState(ticketId);
        void vscode.window.showInformationMessage(
          `Spun ${label} — ${result.servers.length} server(s) running.`,
        );
      } catch (err) {
        provider.refresh(); // partial state is real; surface it
        if (err instanceof SpinCancelledError) {
          // User-initiated: quiet info, not a red error toast.
          void vscode.window.showInformationMessage(`Spin cancelled for ${label}.`);
        } else {
          void vscode.window.showErrorMessage(
            `Spin failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }),
    // "Add ticket" opens the onboarding page (create mode). A manifest is
    // resolved first so the classify-gate + repo picker have services to show.
    vscode.commands.registerCommand('karst.createTicket', () => openOnboardingCreate()),
    vscode.commands.registerCommand('karst.openOnboarding', () => openOnboardingCreate()),
    vscode.commands.registerCommand('karst.editTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      const manifest = await resolveManifest();
      if (!manifest) return;
      currentManifest = manifest;
      currentManifestPath = manifestPathOrThrow();
      onboarding.openEdit(ticketId);
    }),
    vscode.commands.registerCommand('karst.archiveTicket', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      archiveTicket(localStore, ticketId);
      provider.refresh();
    }),
    vscode.commands.registerCommand('karst.unarchiveTicket', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      unarchiveTicket(localStore, ticketId);
      provider.refresh();
    }),
    vscode.commands.registerCommand('karst.deleteTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      const label = ticketLabel(getTicket(localStore, ticketId), currentManifest?.ticketLabelTemplate);
      // Hard delete is irreversible — confirm with a modal before removing the
      // ticket and all its child rows.
      const choice = await vscode.window.showWarningMessage(
        `Permanently delete "${label}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (choice !== 'Delete') return;
      deleteTicket(localStore, ticketId);
      provider.refresh();
    }),
    vscode.commands.registerCommand('karst.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('karst.search', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Filter tickets' });
      provider.setFilter(query ?? '');
    }),
    vscode.commands.registerCommand('karst.filterState', async () => {
      // Facet counts reflect the live store; the active facet is marked so the
      // picker reads as a stateful toggle.
      const counts = facetCounts(
        listTickets(localStore),
        listArchivedTickets(localStore).length,
      );
      const active = provider.getFacet();
      const pick = await vscode.window.showQuickPick(
        FACETS.map((f) => ({
          label: `${f.key === active ? '$(check) ' : ''}${f.label}`,
          description: `${counts[f.key]}`,
          facet: f.key,
        })),
        { placeHolder: 'Filter tickets by state' },
      );
      if (pick) provider.setFacet(pick.facet);
    }),
    vscode.commands.registerCommand('karst.openSettings', () => {
      // Settings reads the manifest file DIRECTLY, not via resolveManifest — an
      // INVALID manifest must open the panel (with its error banner) rather than
      // fire a toast, since fixing a broken manifest is the point of this page.
      // We only bail (with a message) for the two cases the panel can't help:
      // no workspace folder, and no manifest file to edit at all.
      let path: string;
      try {
        path = manifestPathOrThrow();
      } catch {
        void vscode.window.showErrorMessage('Open a folder before using Karst.');
        return;
      }
      if (!existsSync(path)) {
        void vscode.window.showWarningMessage(
          'No karst.yml in this workspace yet — create a ticket to scaffold one.',
        );
        return;
      }
      currentManifestPath = path;
      // loadSettingsState reads the file: valid → typed values, invalid → raw
      // fallback + the error, shown inline. No toast either way.
      settings.open();
    }),
  );
}

export function deactivate(): void {
  endpoint?.close();
  endpoint = undefined;
  store?.close();
  store = undefined;
}

/**
 * The worktree-path rendering context for the dashboard: the manifest's
 * `worktreePathDisplay` + the workspace root. Reads the already-resolved
 * manifest when available, else quietly loads it (no prompts — the dashboard
 * shouldn't nag). Returns undefined (→ absolute paths) when nothing is resolvable.
 */
function worktreePathContext(current: Manifest | undefined): PathContext | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  let manifest = current;
  if (!manifest) {
    try {
      manifest = loadManifest(manifestPathOrThrow());
    } catch {
      return undefined; // no/invalid manifest — fall back to absolute paths
    }
  }
  const display = manifest.worktreePathDisplay ?? 'absolute';
  if (display !== 'relative') return undefined;
  return { display, projectRoot: folder.uri.fsPath };
}

/**
 * A ticket command arg is either a bare ticketId (webview row action posts a
 * number) or an object carrying `ticketId`. Normalize both to a ticket id, or
 * `undefined` if neither shape carries one.
 */
function ticketIdArg(arg: unknown): number | undefined {
  if (typeof arg === 'number') return arg;
  if (arg && typeof arg === 'object' && 'ticketId' in arg) {
    const id = (arg as { ticketId: unknown }).ticketId;
    return typeof id === 'number' ? id : undefined;
  }
  return undefined;
}

/**
 * Compose the `node <cli> context --db <db> --manifest <yml>` prefix the
 * generated `/karst:<id>` command runs to refresh live ticket context. The CLI
 * ships in `dist/cli/main.js`; the manifest path is best-effort (omitted when
 * unresolved — the CLI then renders without the services section).
 */
function buildCliContextPrefix(context: vscode.ExtensionContext, dbPath: string): string {
  const cliEntry = join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js');
  let manifestPath: string | undefined;
  try {
    manifestPath = manifestPathOrThrow();
  } catch {
    manifestPath = undefined;
  }
  return composeContextCommand(cliEntry, dbPath, manifestPath);
}

/** Real webview panels, wrapped in the `DashboardPanel` interface. */
function makePanelHost(context: vscode.ExtensionContext): PanelHost {
  const html = readFileSync(join(HERE, 'ui', 'dashboard', 'webview.html'), 'utf8');
  return {
    createPanel(title): DashboardPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.dashboard',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = html;
      return {
        reveal: () => panel.reveal(),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
      };
    },
  };
}

/** Real terminals, wrapped in the `SessionTerminal` interface. */
function makeTerminalHost(): TerminalHost {
  return {
    createTerminal(opts): SessionTerminal {
      // VS Code terminals have no separate "description" field — fold the title
      // into the tab name so the terminal reads "Karst: <key> — <title>".
      const name = opts.description ? `${opts.name} — ${opts.description}` : opts.name;
      const terminal = vscode.window.createTerminal({
        name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
      });
      return {
        show: () => terminal.show(),
        dispose: () => terminal.dispose(),
        onDidClose: (handler) => {
          const sub = vscode.window.onDidCloseTerminal((closed) => {
            if (closed === terminal) {
              sub.dispose();
              handler();
            }
          });
        },
      };
    },
  };
}

/**
 * Bind dashboard actions to real vscode side-effects. Server lifecycle: stop and
 * open are wired to the supervisor + browser; restart can't fully re-run without
 * the original spawn opts (not persisted), so it stops the server and tells the
 * user to re-spin — honest rather than a fake no-op.
 */
function makeDashboardActions(
  store: Store,
  ticketId: number,
  editTicket: () => void,
  afterServerChange: () => void,
): DashboardActions {
  return {
    stopServer: (serverId) => {
      stopServer(store, serverId);
      afterServerChange();
    },
    restartServer: (serverId) => {
      stopServer(store, serverId);
      afterServerChange();
      void vscode.window.showInformationMessage(
        `Stopped server — re-spin ticket #${ticketId} to restart it with fresh ports.`,
      );
    },
    openServer: (serverId) => {
      const addr = serverAddress(store, serverId);
      if (!addr) {
        void vscode.window.showWarningMessage('That server is no longer running.');
        return;
      }
      void vscode.env.openExternal(vscode.Uri.parse(`http://${addr.host}:${addr.port}`));
    },
    // Copy the server URL to the clipboard (the webview flashes its own feedback).
    copyServerUrl: (serverId) => {
      const addr = serverAddress(store, serverId);
      if (!addr) {
        void vscode.window.showWarningMessage('That server is no longer running.');
        return;
      }
      void vscode.env.clipboard.writeText(`http://${addr.host}:${addr.port}`);
    },
    // No servers yet → let the user spin them from the dashboard (the command
    // owns the service picker + progress; it refreshes the dashboard on success).
    spinServers: () => void vscode.commands.executeCommand('karst.spinTicket', ticketId),
    // Diff → register the worktree with Git, then open the Source Control view
    // so its changes (vs the branch point) are shown. The SCM view is the right
    // whole-worktree affordance (per-file `git.openChange` needs a file target).
    diffWorktree: (path) => {
      void (async () => {
        // git.openRepository expects a plain path string, not a Uri — passing a
        // Uri makes the git extension call `.toLowerCase()` on the object and
        // throw "e.toLowerCase is not a function".
        await vscode.commands.executeCommand('git.openRepository', path);
        await vscode.commands.executeCommand('workbench.view.scm');
      })();
    },
    // Open folder → reveal the worktree in the Explorer (navigate there), not
    // the OS file manager.
    openWorktreeFolder: (path) =>
      void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path)),
    openPr: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    openTicketLink: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    editTicket,
  };
}
