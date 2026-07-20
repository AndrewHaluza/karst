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
import type { AgentAdapter } from './agent/adapter.js';
import { buildSessionSeed } from './agent/seed.js';
import { shouldResumeSession } from './agent/resumeDecision.js';
import { markerStageFor, type MarkerStage } from './agent/markerStage.js';
import { renderFixBrief } from './agent/fixBrief.js';
import { countFixAttempts, fixAttemptsRemain, FIX_ATTEMPT_CAP } from './workflow/fixAttempts.js';
import type { StageKey } from './model/types.js';
import { buildTicketContext, renderTicketContext } from './context/ticketContext.js';
import { resolveModel } from './agent/models.js';
import {
  renderTicketLabel,
  DEFAULT_TERMINAL_NAME_TEMPLATE,
} from './store/ticketLabelTemplate.js';
import { ticketGlyph } from './model/ticketGlyph.js';
import { glyphIconPath } from './ui/glyphIcon.js';
import { glyphThemeColorKey } from './model/glyphColor.js';
import { StatusBarManager } from './ui/statusBar.js';
import { composeContextCommand } from './cli/context.js';
import { composeStageCommand } from './cli/stage.js';
import {
  buildWorkflowInvocation,
  renderWorkflowCommand,
  renderDoneMarkerInstruction,
  KARST_PLUGIN_NAME,
  orchestratorCommandBasename,
} from './agent/workflowCommand.js';
import { startHookEndpoint, type HookEndpoint } from './hooks/endpoint.js';
import { writeHookSettings } from './agent/settings.js';
import { sweepHookSettings } from './agent/settingsSweep.js';
import { listWorktreesByTicket, serverAddress } from './store/dashboard.js';
import { stopServer } from './runtime/supervisor.js';
import { loadManifest, type Manifest } from './manifest/load.js';
import type { PathContext } from './ui/dashboard/state.js';
import { writeServiceSignals } from './manifest/write.js';
import { makeManifestCache } from './extension/manifestCache.js';
import {
  resolveManifest,
  manifestPathOrThrow,
  approachesDirOrThrow,
  agentsDirOrThrow,
  emptyManifest,
  scaffoldManifest,
} from './extension/manifestResolve.js';
import { installApproach, type RunCommand } from './approaches/fetch.js';
import { resolveApproachPrompt } from './approaches/resolve.js';
import type { ApproachDef, TicketingConfig } from './manifest/types.js';
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
import { runStageDriver } from './workflow/driver.js';
import { DriverController, shouldStartDriver, ticketsToSweep } from './workflow/driverController.js';
import { runUat } from './workflow/stages/uat.js';
import { runReview } from './workflow/stages/review.js';
import { shipTicket as runShipTicket } from './workflow/stages/ship.js';
import { advanceTicketOnShip } from './workflow/stages/done.js';
import {
  getTicket,
  ticketLabel,
  listTickets,
  listArchivedTickets,
  archiveTicket,
  unarchiveTicket,
  deleteTicket,
} from './store/tickets.js';
import type { Project } from './store/projects.js';
import { bindProject } from './project/bind.js';
import { resolveProjectSlug } from './project/slug.js';
import { OnboardingManager } from './ui/onboarding/panel.js';
import { buildOnboardingActions, type StartTicketResult } from './ui/onboarding/actions.js';
import { makeOnboardingPanelHost } from './ui/onboarding/host.js';
import {
  makeTokenProvider,
  setToken,
  clearToken,
  hasToken,
} from './extension/secrets.js';
import { makeTicketingProvider, type TicketingProvider } from './integrations/ticketing.js';
import { SettingsManager, type LoadedManifest } from './ui/settings/panel.js';
import { buildSettingsActions } from './ui/settings/actions.js';
import type { SettingsState } from './ui/settings/state.js';
import { makeSettingsPanelHost } from './ui/settings/host.js';
import { writeManifest } from './manifest/write.js';
import { makeLogger, type LogError } from './logging/logger.js';
import { injectPalette } from './model/palette.js';
import { injectCsp, newNonce } from './model/csp.js';
import { injectProviderIdentity } from './model/providerIdentity.js';
import {
  binaryExists,
  checkDependencyFaults,
  commandSucceeds,
  dependencyRegistry,
  ensureCapability,
  renderDependencyFault,
  type Capability,
  type DependencyFault,
} from './runtime/deps.js';
import { buildDepsIndicator } from './ui/depsIndicator.js';
import { WelcomeManager } from './ui/welcome/panel.js';
import { buildWelcomeActions } from './ui/welcome/actions.js';
import { makeWelcomePanelHost } from './ui/welcome/host.js';
import { buildSetupStatus } from './init/status.js';
import { buildWelcomeState } from './ui/welcome/state.js';

/**
 * Extension activation adapter — the host seam (§2.6). Everything below the UI
 * is host-agnostic and unit-tested; this file is the ONE place real `vscode`
 * APIs are bound to those interfaces. It holds no business logic — it wires
 * concrete `vscode` panels/terminals/tree + the hook endpoint into the tested
 * managers, so the extension is a thin shell over covered code.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Per-workspace flag: the user dismissed the fresh-install welcome panel. */
const WELCOME_DISMISSED_KEY = 'karst.welcomeDismissed';
/**
 * The hook port this window bound last time. Rebinding it is what keeps a session
 * that outlived a host restart — it baked the old port into its `--settings` at
 * launch and never re-reads the file — from ECONNREFUSING on every hook it fires.
 *
 * `workspaceState`, NOT `globalState`: every window shares global storage, but each
 * window runs its OWN endpoint on its OWN port. With one global key the second
 * window to start hit EADDRINUSE on the first's port, fell back to an ephemeral
 * one, and wrote THAT over the shared key — so when the first window's host
 * restarted it could no longer reclaim the port its live sessions were still
 * posting to, and every one of them ECONNREFUSED for the rest of its life.
 */
const HOOK_PORT_KEY = 'karst.hookPort';

/**
 * Global (cross-window) flag: the one-shot adoption of pre-v6 tickets has run.
 * Lives in `globalState` deliberately — the DB it guards is global too, so a
 * per-workspace flag would let the second window adopt all over again.
 */
const PROJECT_ADOPTION_KEY = 'karst.projectAdoptionDone';

let store: Store | undefined;
let endpoint: HookEndpoint | undefined;

/** Per-ticket single-flight + Stop bookkeeping for the auto-driver (§11/§12). */
const driver = new DriverController();

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

  // One "Karst" output channel is the sink for every caught error (§ todo-5).
  // Managers/endpoint get `logError`; the extension itself uses `logger`.
  const channel = vscode.window.createOutputChannel('Karst');
  context.subscriptions.push(channel);
  const logger = makeLogger(channel);
  const logError: LogError = (m, e) => logger.error(m, e);
  logger.info('Karst activated');

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
  }), () => worktreePathContext(currentManifest()), () => currentManifest()?.ticketLabelTemplate, logError,
    () => currentProject()?.id);
  const { host: sidebarHost, provider: sidebarProvider } = makeSidebarViewHost(context);
  provider.bind(sidebarHost);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider),
  );

  const settingsDir = context.globalStorageUri.fsPath;
  // Each launch writes a hook-settings file named after this window's ephemeral
  // port, so stale ones pile up. Best-effort, never fatal.
  try {
    const swept = sweepHookSettings(settingsDir);
    if (swept > 0) logger.info(`karst: swept ${swept} stale hook-settings file(s)`);
  } catch (err) {
    logError('karst: hook-settings sweep failed', err);
  }
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
    // Session-close sweep: when the agent's terminal ends, drive the ticket if it
    // is parked at a gate — no dependence on a SessionEnd hook reaching the endpoint.
    (ticketId) => maybeDrive(ticketId, 'session-closed'),
  );

  // The live manifest. Loaded on first read rather than assigned by whichever
  // command ran first: surfaces reachable without create/edit (the dashboard,
  // opened straight from the sidebar) used to see `undefined` here and silently
  // drop the board link, label template, and worktree paths.
  const manifests = makeManifestCache({
    pathOf: manifestPathOrThrow,
    exists: existsSync,
    load: loadManifest,
  });
  const currentManifest = (): Manifest | undefined => manifests.get();

  // Drop the cached copy so the next read re-reads from disk. Shared by
  // onboarding (after a signal writeback) and settings (after a save) so both
  // surfaces observe the same reload behavior from one implementation.
  const reloadManifest = (): void => manifests.reload();

  // This window's project (§ projects / multi-window). Every window shares one
  // global DB, so without a project id each one would list — and act on — the
  // others' tickets. Resolved lazily and memoized: the workspace root is fixed
  // for the window's lifetime, and so is the slug derived from it.
  //
  // Identity comes from the manifest's `id:` when present, else a slug derived
  // from the workspace root. The fallback matters: it means a project binds even
  // with no manifest yet (the welcome/scaffold path), so tickets created during
  // onboarding are never orphaned.
  let boundProject: Project | undefined;
  const currentProject = (): Project | undefined => {
    if (boundProject) return boundProject;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined; // no folder → no project; commands already refuse

    const root = folder.uri.fsPath;
    const slug = resolveProjectSlug(currentManifest()?.id, root);
    try {
      const { project, adopted } = bindProject(
        localStore,
        { slug, name: folder.name, rootPath: root },
        {
          done: () => context.globalState.get<boolean>(PROJECT_ADOPTION_KEY, false),
          markDone: () => void context.globalState.update(PROJECT_ADOPTION_KEY, true),
        },
      );
      boundProject = project;
      if (adopted > 0) {
        logger.info(`karst: adopted ${adopted} pre-existing ticket(s) into project "${slug}"`);
      }
      return project;
    } catch (err) {
      // A window with no project shows an empty board rather than every other
      // project's tickets — failing closed is the safe direction here.
      logError('karst: could not bind project', err);
      return undefined;
    }
  };

  // Live setup status for the welcome page. Reads disk/PATH fresh on every call
  // (no caching) so re-check and post-scaffold pushes reflect reality. Guarded:
  // no workspace folder → manifest counts as missing, provider defaults to claude.
  const loadWelcomeState = () => {
    let manifestExists = false;
    try {
      manifestExists = existsSync(manifestPathOrThrow());
    } catch {
      manifestExists = false;
    }
    const provider = (currentManifest()?.agentProvider ?? 'claude');
    // The panel's re-check button routes here; repaint the bar from the same
    // moment's truth, or installing a tool clears the checklist and leaves the
    // status bar still claiming it's missing.
    refreshDepsStatus();
    return buildWelcomeState(
      buildSetupStatus({ manifestExists, provider, probe: binaryExists, ready: commandSucceeds }),
    );
  };

  const welcome = new WelcomeManager(
    loadWelcomeState,
    makeWelcomePanelHost(context),
    buildWelcomeActions({
      scaffoldManifest,
      setDismissed: () => void context.workspaceState.update(WELCOME_DISMISSED_KEY, true),
      runCommand: (command) => void vscode.commands.executeCommand(command),
    }),
    logError,
  );

  // The startup toast is dismissible and gone in seconds; a tool that is missing
  // (or signed out) stays that way until the user fixes it. The status bar is the
  // surface that outlives the toast — it clicks through to the checklist, and
  // clears itself on any recheck.
  const depsStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  depsStatus.command = 'karst.recheckDeps';
  context.subscriptions.push(depsStatus);

  /** Reprobe, repaint the status bar, and report what is still unusable. */
  const refreshDepsStatus = (): DependencyFault[] => {
    const provider = currentManifest()?.agentProvider ?? 'claude';
    const faults = checkDependencyFaults(dependencyRegistry(provider), binaryExists, commandSucceeds);
    const indicator = buildDepsIndicator(faults);
    if (!indicator) {
      depsStatus.hide();
      return faults;
    }
    depsStatus.text = indicator.text;
    depsStatus.tooltip = indicator.tooltip;
    depsStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    depsStatus.show();
    return faults;
  };

  /**
   * Refuse an action whose tools are missing, and say what to install.
   *
   * The startup preflight only warns, and it did so minutes ago; this is the
   * moment the user actually needs the tool. Returns true when the capability is
   * usable. The guard lives here, in the host layer, because the workflow modules
   * it protects are host-agnostic by invariant — a PATH probe wired inside them
   * would fail their own unit tests on a machine without gh.
   */
  const guardCapability = (capability: Capability, silent = false): boolean => {
    const provider = currentManifest()?.agentProvider ?? 'claude';
    const faults = ensureCapability(
      capability,
      dependencyRegistry(provider),
      binaryExists,
      commandSucceeds,
    );
    if (faults.length === 0) return true;
    // The bar may predate this: a tool can go missing (or be installed) after
    // activation, and a refusal is proof of what PATH says right now.
    refreshDepsStatus();
    for (const f of faults) logger.warn(`blocked: '${f.dep.binary}' is ${f.state}`);
    if (!silent) {
      const text = faults
        .map((f) => renderDependencyFault(f.dep, f.state))
        .filter((m): m is string => m !== null)
        .join(' ');
      void vscode.window.showErrorMessage(text, 'Open setup checklist').then((choice) => {
        if (choice === 'Open setup checklist') welcome.open();
      });
    }
    return false;
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
        manifest: currentManifest() ?? emptyManifest(),
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
        approaches: currentManifest()?.approaches ?? [],
        agentsMeta: currentManifest()?.agents ?? {},
      });
    } catch {
      return [];
    }
  };

  // Onboarding page: create + edit tickets on one persistent surface. The
  // manifest is read fresh per-open (getter) so a signal write is reflected
  // immediately. The ClickUp provider + agent adapter are wired with the secure
  // token seam; the manifest/path are read at call time (resolved on open).
  // One status-tinted logo per glyph, materialized on demand under global
  // storage. Every karst tab derives its icon from the SAME `ticketGlyph` the
  // sidebar rows use, so a ticket reads the same color on every surface. A
  // missing ticket / unreadable asset degrades to "no icon", never a throw.
  const tabIconFor = (ticketId: number): string | undefined => {
    try {
      const t = getTicket(localStore, ticketId);
      return glyphIconPath(ticketGlyph(t), {
        storageDir: context.globalStorageUri.fsPath,
        assetSvgPath: join(HERE, '..', 'media', 'karst.svg'),
      });
    } catch {
      return undefined;
    }
  };

  const onboarding = new OnboardingManager(
    localStore,
    () => currentManifest() ?? emptyManifest(),
    makeOnboardingPanelHost(context),
    buildOnboardingActions({
      store: localStore,
      // These read the manifest at call time so a manifest resolved on open (or
      // loaded on demand) is available to fetch/suggest/save.
      get manifest() {
        return currentManifest() ?? emptyManifest();
      },
      get manifestPath() {
        return manifests.path() ?? '';
      },
      // Same getter pattern: the project binds lazily, so read it at call time
      // rather than capturing whatever was (not yet) resolved at wiring time.
      get projectId() {
        return currentProject()?.id;
      },
      // Read `ticketing` fresh so a provider/teamId change saved from settings
      // applies without a reload (same getter pattern as `manifest` above).
      get provider() {
        return makeTicketingProvider(
          (currentManifest() ?? emptyManifest()).ticketing,
          fetch,
          makeTokenProvider(context),
        );
      },
      // Read fresh so a provider choice saved from settings takes effect on
      // the next onboarding action, mirroring `get provider()` above — this
      // object is built once at activation, so a static property would be
      // permanently stuck on the fallback ('claude') read at that moment.
      get adapter() {
        return resolveAdapter((currentManifest() ?? emptyManifest()).agentProvider ?? 'claude');
      },
      onChange: () => provider.refresh(),
      // Finish handoff: scope the ticket's selected repos (worktrees, no
      // servers) and open the agent session seeded with its chosen approach.
      // Servers stay deferred — they come up only when a stage needs to verify.
      startTicket: async (ticketId: number): Promise<StartTicketResult> => {
        const t = getTicket(localStore, ticketId);
        const hot = t.selectedRepos;
        // Nothing to scope → the ticket stays pending. Report it so onboarding
        // keeps the page open with the reason, instead of looking hung.
        if (hot.length === 0) {
          return { ok: false, message: 'Select at least one repository to start this ticket.' };
        }
        const manifest = currentManifest() ?? emptyManifest();
        try {
          confirmScope(localStore, manifest, ticketId, hot);
          // Scope is complete the moment its worktrees exist (scope has only a
          // pass edge → impl; it is not a gate). Pass it so the ticket advances
          // to impl running — the agent session opens in the impl worktree.
          transition(localStore, ticketId, 'scope', { kind: 'passed' });
          provider.refresh();
          // Await so a launch failure (missing worktree, terminal spawn throw)
          // surfaces as a failed start instead of a silent stall with the ticket
          // already advanced to impl.
          await vscode.commands.executeCommand('karst.openSession', ticketId);
          return { ok: true };
        } catch (err) {
          const message = `Could not start ticket: ${err instanceof Error ? err.message : String(err)}`;
          void vscode.window.showErrorMessage(message);
          return { ok: false, message };
        }
      },
      // A started ticket belongs to its dashboard — onboarding hands off there.
      openDashboard: (ticketId: number) => dashboard.openDashboard(ticketId),
      writeSignals: writeServiceSignals,
      // Re-read the manifest from disk after a signal writeback so the panel's
      // manifest getter (currentManifest) reflects the saved signals — the gate
      // clears and the repo row shows them on the next pushState.
      reloadManifest,
      listInstalledIds: listInstalledApproachIds,
      openUrl: (url: string) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    }),
    listInstalledApproachIds,
    listAgents,
    // Locks the model/effort picker while a session terminal is live (§ B1).
    (ticketId) => sessions.isOpen(ticketId),
    logError,
    tabIconFor,
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
        approaches: currentManifest()?.approaches ?? [],
      });
      const agentsMeta = currentManifest()?.agents ?? {};
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
      // The shell-out gate for npm-source installs. Modal (like the hard-delete
      // confirm) so it can't be missed, and shows the command VERBATIM — the
      // point is that the user sees the exact string karst.yml is asking to run.
      confirmInstallCommand: async (command: string): Promise<boolean> => {
        // `message` is the dialog's bold title and `detail` its body — so the
        // question goes in the title and the command in the detail. Putting a
        // long `npx …` string in the title clips it, which would hide the very
        // thing the user is being asked to approve.
        const choice = await vscode.window.showWarningMessage(
          'Run this command to install the approach?',
          {
            modal: true,
            detail: `It comes from this workspace’s karst.yml and runs in a shell:\n\n${command}`,
          },
          'Run',
        );
        return choice === 'Run';
      },
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
      makeProvider: (config) => makeTicketingProvider(config, fetch, makeTokenProvider(context)),
    }),
    listInstalledApproachIds,
    () => hasToken(context),
    listAgentRows,
    listApproachCommands,
    logError,
  );

  const dashboard = new DashboardManager(
    localStore,
    makePanelHost(context),
    (ticketId) =>
      makeDashboardActions(
        localStore,
        ticketId,
        agentAdapter,
        () => onboarding.openEdit(ticketId),
        () => {
          provider.refresh();
          dashboard.pushState(ticketId);
          // Same sweep the tab icon rides on — the status text must not lag it.
          showStatusFor(ticketId);
        },
        logError,
        guardCapability,
        () => currentManifest()?.ticketing,
        () =>
          makeTicketingProvider(
            currentManifest()?.ticketing,
            fetch,
            makeTokenProvider(context),
          ),
      ),
    () => worktreePathContext(currentManifest()),
    () => currentManifest()?.ticketLabelTemplate,
    // Live ticketing config so the dashboard links to the source board (§ C3).
    () => currentManifest()?.ticketing,
    logError,
    // Resolve an approach id → its workflow phase names for the read-only
    // impl-stage breakdown (§ impl sub-stages). Missing package/dir → no
    // breakdown, never a throw.
    (approachId) => {
      if (!approachId) return [];
      try {
        const pkg = readApproachPackage(approachesDirOrThrow(), approachId);
        return pkg?.workflow?.map((p) => p.name) ?? [];
      } catch {
        return [];
      }
    },
    tabIconFor,
  );

  // The live verbose channel (§ naming/status): whatever a tab or terminal
  // abbreviates to a color, this states in words for the ticket the user last
  // touched. Blocked (`red`) also takes the warning background — a blocker is
  // never signalled by color alone.
  const sbItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(sbItem);
  const statusBar = new StatusBarManager({
    set: (text, warning, command) => {
      sbItem.text = text;
      sbItem.backgroundColor = warning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      sbItem.command = { command: command.id, title: 'Open dashboard', arguments: [command.arg] };
      sbItem.show();
    },
    hide: () => sbItem.hide(),
  });

  /** Re-render the status bar for a ticket; a missing ticket hides the item. */
  const showStatusFor = (ticketId: number): void => {
    try {
      const t = getTicket(localStore, ticketId);
      statusBar.render({
        ticketId,
        key: t.key ?? `#${ticketId}`,
        stage: t.stageCurrent ?? 'none',
        state: t.agentState ?? 'none',
        glyph: ticketGlyph(t),
      });
    } catch {
      statusBar.render(null);
    }
  };

  // Where the auto-driver persists its gate-run evidence (§11/§12), mirroring
  // the per-ticket layout the runners themselves expect.
  const artifactDirFor = (ticketId: number): string =>
    join(context.globalStorageUri.fsPath, 'artifacts', String(ticketId));

  // Auto-run the deterministic uat/review gates for a ticket after the
  // impl/fix marker (or a prior gate) leaves it at a gate boundary. Single-flight
  // via `driver.begin`/`end`; never authors a transition itself — `runUat`/
  // `runReview` own that (single-writer preserved). `runStageDriver` expects
  // each runner to resolve the ticket's *new* `stageCurrent`, so wrap the real
  // outcome-returning runners with a re-read.
  async function driveTicket(ticketId: number): Promise<void> {
    if (!driver.begin(ticketId)) return; // a run is already in flight
    logger.info(`stage driver: begin ticket ${ticketId}`);
    try {
      const outcome = await runStageDriver(
        {
          store: localStore,
          worktreeFor: (id) => listWorktreesByTicket(localStore, id)[0]?.path ?? null,
          onProgress: (id, stage, status) => {
            logger.info(`stage driver: ticket ${id} ${stage} → ${status}`);
            provider.refresh();
            dashboard.pushState(id);
          },
          shouldContinue: () => driver.shouldContinue(ticketId),
          runUat: (id, cwd) =>
            runUat(localStore, { ticketId: id, cwd, artifactDir: artifactDirFor(id) }).then(
              () => getTicket(localStore, id).stageCurrent as StageKey,
            ),
          runReview: (id, cwd) =>
            runReview(localStore, { ticketId: id, cwd, artifactDir: artifactDirFor(id) }).then(
              () => getTicket(localStore, id).stageCurrent as StageKey,
            ),
        },
        ticketId,
      );
      logger.info(
        `stage driver: ticket ${ticketId} halted at ${outcome.stage} (${outcome.status}` +
          `${outcome.reason ? `: ${outcome.reason}` : ''})`,
      );
      if (outcome.stage === 'fix') autoResumeFix(ticketId);
    } catch (e) {
      logError('stage driver failed', e);
    } finally {
      driver.end(ticketId);
      provider.refresh();
      dashboard.pushState(ticketId);
    }
  }

  // A failed gate parks the ticket at `fix` with nothing running: karst never
  // calls `runFix`, and the driver stops at fix because a fix needs an agent, not
  // a gate. So resume the agent here — with the failing gate's reason + log and
  // the `stage fix pass` marker.
  //
  // Two ways in, because gates now run WHILE the session is open (the marker, not
  // the terminal, says the work is done). If that session is still live, the agent
  // is sitting at its prompt: `openSession` would only focus the terminal and drop
  // the brief on the floor, so nudge it instead. Only a closed session gets a fresh
  // (--resume) launch. The marker rides along either way — the live session was
  // seeded the IMPL marker, and firing that at fix would move the wrong stage.
  //
  // Capped: an unfixable ticket would otherwise loop fix→review→fix forever,
  // burning tokens with no human ever looking. At the cap the ticket stays parked
  // and the dashboard says so ("fix attempts ran out…", with a Resume button), so
  // the loop always ends in a human decision rather than silence.
  function autoResumeFix(ticketId: number): void {
    const t = getTicket(localStore, ticketId);
    const attempts = countFixAttempts(t.stages);
    if (!fixAttemptsRemain(attempts)) {
      logger.info(
        `stage driver: ticket ${ticketId} parked at fix — ${attempts} gate failures, ` +
          `at the cap of ${FIX_ATTEMPT_CAP}; leaving it for a human`,
      );
      return;
    }
    const label = t.key ?? `#${ticketId}`;
    const brief =
      renderFixBrief(label, t.stages) ??
      `A gate failed for ticket ${label}. Re-run the checks, fix what they report, and confirm they pass.`;
    const marker = renderDoneMarkerInstruction(
      buildCliStagePrefix(context, dbPath, 'fix'),
      t.key ?? String(ticketId),
    );
    if (sessions.nudge(ticketId, `${brief}\n\n${marker}`)) {
      logger.info(`stage driver: ticket ${ticketId} → nudged live session to fix (attempt ${attempts})`);
      return;
    }
    logger.info(`stage driver: ticket ${ticketId} → resuming agent to fix (attempt ${attempts})`);
    void vscode.commands.executeCommand('karst.openSession', ticketId);
  }

  // The §5.4-safe driver nudge, from any trigger: the explicit marker (or a prior
  // gate) already transitioned the stage; if the ticket now sits at a deterministic
  // gate, kick the driver to run it — an open terminal does NOT hold it back, since
  // the marker (not the session) is what says the work is done. Reused by the hook
  // channel, the session-close sweep, and the activation sweep so a gate never
  // strands just because one trigger (e.g. an unreachable SessionEnd hook) was missed.
  let gateToolsWarned = false;
  const maybeDrive = (ticketId: number, trigger: string): void => {
    const t = getTicket(localStore, ticketId);
    if (!shouldStartDriver(t.stageCurrent as StageKey)) return;
    // A missing gate tool is NOT a failing gate. Left unguarded, every gate exits
    // nonzero, the driver reads that as a code verdict, and the ticket parks at
    // fix in a loop no agent can win. Warn once — the activation sweep drives
    // every parked ticket, and N toasts say nothing the first one didn't.
    if (!guardCapability('gates', gateToolsWarned)) {
      gateToolsWarned = true;
      logger.warn(`stage driver: ${trigger} → ticket ${ticketId} not driven, gate tools missing`);
      return;
    }
    logger.info(`stage driver: ${trigger} → drive ticket ${ticketId} at ${t.stageCurrent}`);
    void driveTicket(ticketId);
  };

  // The hook channel fans liveness/needs-you out to the sidebar + any open
  // dashboard, so a waiting agent turns amber without opening its terminal.
  const rememberedPort = context.workspaceState.get<number>(HOOK_PORT_KEY) ?? 0;
  endpoint = await startHookEndpoint(localStore, rememberedPort, (ticketId) => {
    provider.refresh();
    dashboard.pushState(ticketId);
    maybeDrive(ticketId, 'hook');
  }, logError);
  if (endpoint.port !== rememberedPort) {
    await context.workspaceState.update(HOOK_PORT_KEY, endpoint.port);
  }

  // Activation sweep: resume any ticket already parked at a gate. Recovers a ticket
  // stranded when the trigger that would normally kick the driver never arrived
  // (dead/stale hook port, IDE closed mid-gate) — every window reload becomes a
  // self-heal, without inferring any verdict (§5.4-safe).
  //
  // Scoped to this window's project: driving a ticket opens terminals and runs
  // gates against *this* window's manifest, so sweeping another project's
  // tickets would resolve their services against the wrong repo paths.
  for (const id of ticketsToSweep(listTickets(localStore, { projectId: currentProject()?.id }))) {
    maybeDrive(id, 'activation-sweep');
  }

  // Startup dependency preflight (§ todo-5): karst shells out to tools it doesn't
  // bundle. The registry is the whole list — never hand-maintain one here, or the
  // preflight and the welcome checklist drift apart.
  const depFaults = refreshDepsStatus();

  // Fresh-install welcome: auto-open the getting-started panel when this
  // workspace has no manifest yet and the user hasn't dismissed it. Per-workspace
  // (workspaceState) so a new project re-triggers even if dismissed elsewhere.
  let autoOpenedWelcome = false;
  if (vscode.workspace.workspaceFolders?.[0]) {
    let manifestExists = false;
    try {
      manifestExists = existsSync(manifestPathOrThrow());
    } catch {
      manifestExists = false;
    }
    const dismissed = context.workspaceState.get<boolean>(WELCOME_DISMISSED_KEY) === true;
    if (!manifestExists && !dismissed) {
      welcome.open();
      autoOpenedWelcome = true;
    }
  }

  // Suppress the toast when the panel already shows the same dependency status.
  if (depFaults.length > 0 && !autoOpenedWelcome) {
    for (const f of depFaults) logger.warn(`dependency '${f.dep.binary}' is ${f.state}`);
    void vscode.window
      .showWarningMessage(
        depFaults
          .map((f) => renderDependencyFault(f.dep, f.state))
          .filter((m): m is string => m !== null)
          .join(' '),
        'Open setup checklist',
      )
      .then((choice) => {
        if (choice === 'Open setup checklist') welcome.open();
      });
  }

  // Shared entry: resolve the manifest, remember it for onboarding actions, and
  // open the create-mode page. Used by both createTicket and openOnboarding.
  const openOnboardingCreate = async (): Promise<void> => {
    const manifest = await resolveManifest();
    if (!manifest) return; // no folder / scaffolded / invalid — message shown
    manifests.set(manifest, manifestPathOrThrow());
    onboarding.openCreate();
  };

  // Cross-window freshness (§ projects / multi-window). Sidebar refreshes are
  // driven by in-window commands and this window's own hook endpoint, so work
  // done in another window — even on a ticket this project owns, via a session
  // whose hooks land there — leaves this board stale until something local
  // happens. Regaining focus is the cheap, well-timed moment to re-read: it is
  // exactly when the user looks at the board, and it costs nothing while the
  // window sits in the background.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('karst.openDashboard', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      dashboard.openDashboard(ticketId);
      showStatusFor(ticketId);
    }),
    vscode.commands.registerCommand('karst.openSession', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      // Without the CLI the terminal opens, prints a shell "command not found",
      // and sits there looking like karst did something.
      if (!guardCapability('sessions')) return;
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
        const approaches = currentManifest()?.approaches ?? [];
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
        buildTicketContext(localStore, currentManifest(), ticketId),
      );
      // The done marker (§5.4) rides EVERY seed, not just the approach path:
      // `materializeApproach` only runs for an installed package or a solo agent,
      // so a `direct` ticket would otherwise never be told to fire the marker and
      // would strand at `impl`. The marker names the stage the session is actually
      // working on — a resume at `fix` gets `stage fix pass`, not the impl marker.
      // The concrete ticket key is the arg (the seed is plain text — no
      // `$ARGUMENTS` substitution).
      const markerStage = markerStageFor(t.stageCurrent as StageKey | null);
      const markerInstruction = renderDoneMarkerInstruction(
        buildCliStagePrefix(context, dbPath, markerStage),
        t.key ?? String(ticketId),
      );
      const initialPrompt = buildSessionSeed(
        ticketContextMd,
        approachPrompt ?? delegation,
        invocation,
        markerInstruction,
      );

      // Resume the captured session when continuing interactive work, so the
      // agent keeps its context instead of re-deriving from a cold seed (§5.3).
      // `stageCurrent` is stored loosely as `string | null` at the store layer
      // (like `stages.ts`'s `stage_key as StageKey`); it is always one of
      // STAGE_KEYS in practice. The marker rides the resume nudge too — a
      // resumed impl/fix session still has to fire it when work is done.
      const resumeId = shouldResumeSession({ sessionId: t.sessionId, stageCurrent: t.stageCurrent as StageKey })
        ? (t.sessionId ?? undefined)
        : undefined;
      // At `fix` the resume has a specific job — the gate that just failed wrote
      // its reason and log, so point the agent at them instead of a vague
      // "continue". `currentStage` carries both (state.ts → buildStepper).
      const fixBrief =
        t.stageCurrent === 'fix' ? renderFixBrief(t.key ?? `#${ticketId}`, t.stages) : null;
      const seedPrompt = resumeId
        ? `${fixBrief ?? `Continue the in-progress work on ticket ${t.key ?? `#${ticketId}`}. Re-read live state if needed.`}\n\n${markerInstruction}`
        : initialPrompt;

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
            cliStagePrefix: buildCliStagePrefix(context, dbPath),
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
      const approachDef = (currentManifest()?.approaches ?? []).find((a) => a.id === t.approach);
      const approachIsSourced = approachDef?.source !== undefined;
      if (t.approach && approachIsSourced && approachPrompt === null && extraArgs === undefined) {
        void vscode.window.showWarningMessage(
          `Approach "${t.approach}" produced no method prompt or loadable artifacts — ` +
            `opening with ticket context only. Check the approach's entrypoint in the manifest and reinstall it.`,
        );
      }

      // Resolve the launch model: the ticket's own model wins, else the manifest
      // default, else undefined (let the agent CLI pick). Threaded as `--model`.
      const model = resolveModel(t.model, currentManifest()?.defaultModel);

      // Terminal name/icon/color are frozen at creation, so resolve the ticket's
      // glyph ONCE here: the color is the stage-at-launch, and the template keeps
      // the stage legible as text for the rest of the terminal's life.
      const glyph = ticketGlyph(t);
      const naming = {
        name: renderTicketLabel(
          t,
          currentManifest()?.terminalNameTemplate ?? DEFAULT_TERMINAL_NAME_TEMPLATE,
        ),
        iconPath: glyphIconPath(glyph, {
          storageDir: context.globalStorageUri.fsPath,
          assetSvgPath: join(HERE, '..', 'media', 'karst.svg'),
        }),
        color: glyphThemeColorKey(glyph),
      };

      sessions.openSession(
        ticketId,
        wt.path,
        { key: t.key, title: t.title },
        seedPrompt,
        extraArgs,
        model,
        resumeId,
        naming,
      );
      showStatusFor(ticketId);
    }),
    vscode.commands.registerCommand('karst.spinTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      // A spin creates worktrees and installs deps into them; both tools fail
      // deep inside that, long after the user stopped watching.
      if (!guardCapability('worktrees') || !guardCapability('gates')) return;

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
      manifests.set(manifest, manifestPathOrThrow());
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
      const label = ticketLabel(getTicket(localStore, ticketId), currentManifest()?.ticketLabelTemplate);
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
    vscode.commands.registerCommand('karst.showLogs', () => channel.show()),
    vscode.commands.registerCommand('karst.search', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Filter tickets' });
      provider.setFilter(query ?? '');
    }),
    vscode.commands.registerCommand('karst.filterState', async () => {
      // Facet counts reflect the live store; the active facet is marked so the
      // picker reads as a stateful toggle.
      const scope = { projectId: currentProject()?.id };
      const counts = facetCounts(
        listTickets(localStore, scope),
        listArchivedTickets(localStore, scope).length,
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
      // loadSettingsState reads the file: valid → typed values, invalid → raw
      // fallback + the error, shown inline. No toast either way.
      settings.open();
    }),
    vscode.commands.registerCommand('karst.openGettingStarted', () => welcome.open()),
    // Reprobe on demand: the user installs a tool in a terminal, clicks the status
    // bar, and karst answers without a window reload. No polling — nothing else
    // knows when an install finishes, and a timer would probe PATH forever.
    vscode.commands.registerCommand('karst.recheckDeps', () => {
      const missing = refreshDepsStatus();
      if (missing.length === 0) {
        void vscode.window.showInformationMessage('Karst has every tool it needs.');
        return;
      }
      welcome.open();
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

/**
 * Compose the `node <cli> stage <stage> pass --db <db> --ticket` prefix a session
 * runs (ticket key appended) to fire the done marker for the stage it is working
 * on. Same CLI entry as context. The manifest rides along so the CLI can tell
 * which project the ticket key belongs to — two projects sharing the DB may
 * legitimately use the same key.
 *
 * `stage` defaults to `impl` — the generated `/karst:<id>` command is
 * materialized once at install time, before any ticket exists, so it can only
 * ever carry the impl boundary. A live session seed passes the ticket's actual
 * stage, so a resume at `fix` fires `fix pass` instead of the impl marker (which
 * would throw: there is no impl→? edge from fix).
 */
function buildCliStagePrefix(
  context: vscode.ExtensionContext,
  dbPath: string,
  stage: MarkerStage = 'impl',
): string {
  const cliEntry = join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js');
  // Best-effort, same as the context prefix: an unresolved manifest just means
  // the CLI falls back to an unscoped key lookup.
  let manifestPath: string | undefined;
  try {
    manifestPath = manifestPathOrThrow();
  } catch {
    manifestPath = undefined;
  }
  return composeStageCommand(cliEntry, dbPath, stage, manifestPath);
}

/** Real webview panels, wrapped in the `DashboardPanel` interface. */
function makePanelHost(context: vscode.ExtensionContext): PanelHost {
  const html = injectProviderIdentity(
    injectPalette(readFileSync(join(HERE, 'ui', 'dashboard', 'webview.html'), 'utf8')),
  );
  return {
    createPanel(title): DashboardPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.dashboard',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      // Nonce per panel, not per host (the html above is built once and reused).
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: () => panel.reveal(),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
        setIcon: (p: string) => {
          panel.iconPath = vscode.Uri.file(p);
        },
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
        // Name/icon/color are frozen at creation — `Terminal.creationOptions` is
        // readonly, so the launch glyph is what the tab keeps for its lifetime.
        ...(opts.iconPath ? { iconPath: vscode.Uri.file(opts.iconPath) } : {}),
        ...(opts.color ? { color: new vscode.ThemeColor(opts.color) } : {}),
      });
      return {
        show: () => terminal.show(),
        sendText: (text) => terminal.sendText(text, true),
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
/** True when the capability's tools are present; otherwise tells the user why not. */
type CapabilityGuard = (capability: Capability, silent?: boolean) => boolean;

function makeDashboardActions(
  store: Store,
  ticketId: number,
  agentAdapter: AgentAdapter,
  editTicket: () => void,
  afterServerChange: () => void,
  logError: LogError,
  guardCapability: CapabilityGuard,
  // Read fresh at call time so a status saved in settings applies without a
  // window reload — same getter pattern as the onboarding provider.
  ticketing: () => TicketingConfig | undefined,
  ticketingProvider: () => TicketingProvider,
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
    // Stop the auto-driver's next gate run for this ticket (it halts at the
    // next boundary check, never mid-gate — see `shouldContinue`).
    stopDriver: () => driver.requestStop(ticketId),
    // Human confirms ship: open the PR(s) for every hot repo, then let the
    // caller (dashboard) refresh so `done` (or a fresh PR list) shows up.
    shipTicket: () => {
      // Before the model call, not after: `runShipTicket` asks a model to write
      // the PR description first, so an unguarded click burns a call per repo and
      // then dies at `gh pr create`.
      if (!guardCapability('ship')) return;
      void runShipTicket(store, { ticketId }, undefined, agentAdapter)
        .then(async () => {
          // The PRs are open and the branch is pushed — the irreversible part
          // succeeded, and ship.ts already transitioned to done. So a failed
          // status push warns; it never drags a shipped ticket back to red.
          try {
            const res = await advanceTicketOnShip(
              store,
              ticketId,
              ticketing(),
              ticketingProvider(),
            );
            if (!res.advanced && res.reason === 'no-ref') {
              logError(
                `ticket #${ticketId} shipped without a status update: no provider ref`,
                undefined,
              );
            }
          } catch (e) {
            logError('ticket status update failed', e);
            void vscode.window.showWarningMessage(
              `Ticket shipped, but the status update failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
          afterServerChange();
        })
        .catch((e) => {
          logError('ship failed', e);
          // `shipTicket` already recorded the reason on the ship stage, so the
          // dashboard now explains itself — but the user just clicked a button
          // and deserves an answer to THAT click, not a ticket that quietly goes
          // red. Refresh first so the fault card is there when the toast lands.
          afterServerChange();
          void vscode.window.showErrorMessage(
            `Ship failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    },
    // Resume: same interactive-open path the sidebar/dashboard "open session"
    // action already uses; `SessionManager.openSession` resolves --resume vs.
    // a fresh launch on its own.
    resumeTicket: () => void vscode.commands.executeCommand('karst.openSession', ticketId),
    // A failed gate's log, opened read-only in an editor — the "why" behind a red
    // node, without sending the user to the dev-only output channel.
    openStageLog: (path) => {
      void (async () => {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (e) {
          // The gate wrote the path, but the file can be gone (worktree removed).
          void vscode.window.showWarningMessage(`Cannot open the log at ${path}.`);
          logError('open stage log failed', e);
        }
      })();
    },
  };
}
