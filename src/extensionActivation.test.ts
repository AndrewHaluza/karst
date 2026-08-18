import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('extension activation', () => {
  it('starts after a window reload so live Codex hook endpoints are restored', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { activationEvents?: string[] };

    expect(pkg.activationEvents).toContain('onStartupFinished');
  });

  // A ticket reaches `done` only when its PRs have landed, and the landing can
  // happen where no click in this window can see it — a teammate merging on
  // GitHub. The PR sweep is the only path that notices, so the wiring is pinned
  // here: without it a merged ticket sits at `ship`, blocked, until someone
  // reopens the dashboard, and its provider status is never pushed at all.
  it('settles the merge gate on the PR sweep, and pushes the status of what landed', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain('settleShipGates(');
    expect(source).toContain('{ projectId: project.id }');
    expect(source).toContain('for (const id of landed) void pushDoneStatus(id, false);');
  });

  // The provider's post-delivery status used to be pushed the moment the PRs
  // opened, which is exactly the claim this ticket exists to stop making. It now
  // fires from whichever path actually moved the ticket to `done`.
  it('pushes the provider status only for a ticket that actually reached done', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // Ship: only the nothing-to-merge case walks straight through to done —
    // the guard rides the shared ship-saga seam (click AND stranded recovery).
    expect(source).toContain("if (getTicket(localStore, ticketId).stageCurrent === 'done') {");
    // Merge: only the merge that finished the ticket.
    expect(source).toContain('if (result.completedTicket) await onTicketCompleted();');
  });

  // A done ticket is archived on a DELAY (manifest `archiveDoneAfterDays`),
  // never when it reaches done — a freshly-done ticket must stay on the board —
  // and a ticket may sit at done for any duration, so the archive is a SWEEP,
  // not a transition hook. The only timer that already exists is the PR sweep,
  // so it rides that tick (like settleShipGates): once at activation, then
  // every PR_SYNC_INTERVAL_MS, with no second interval to dispose. Without the
  // wiring, done tickets accumulate on the board forever.
  it('auto-archives done tickets on the PR sweep after the configured delay', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain('autoArchiveDoneTickets(localStore, {');
    expect(source).toContain(
      '(currentManifest() ?? emptyManifest()).archiveDoneAfterDays ??',
    );
  });

  // Closing a ticket with its DONE terminals is a SETTING (`closeDoneTerminals
  // WithTicket`), off by default — so the wiring has two halves, both pinned
  // here: the archive command and the auto-archive sweep must each consult the
  // flag before disposing anything, and the dispose must go through the
  // exit-status-gated helper (only an EXITED terminal may be closed, never a
  // live session). Source assertions, like every case in this file: the
  // decision logic runs in `ui/doneTerminals.test.ts`, this pins that the host
  // actually wires it behind the setting.
  it('closes a closed ticket\'s done terminals only behind the manifest setting', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // The setting gate exists, reads the live manifest, and both triggers ride it.
    expect(source).toContain('closeDoneTerminalsWithTicket === true');
    expect(source).toContain('closeTicketDoneTerminals(ticketId)');
    expect(source).toMatch(/for \(const id of archived\)[\s\S]{0,80}?closeTicketDoneTerminals\(id\)/);
    // Only exited terminals qualify — the helper is what the binding feeds.
    expect(source).toContain('exited: terminal.exitStatus !== undefined');
    expect(source).toContain('closeDoneTerminalsOf(probes, ticketId)');
  });

  // `removeWorktree` reaps the servers it removes a tree out from under, but it
  // can only see removals karst performs. A worktree deleted by anything else —
  // or a server leaked by a build that predates that fix — is reachable only
  // from a sweep, and an unreaped one is invisible: detached, reparented to
  // init, holding its port and ~1 GB while serving a deleted directory.
  it('sweeps servers whose directory is gone on activation, and says which it stopped', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // A source assertion, like every case in this file: `extension.ts` imports
    // `vscode` and cannot load under vitest. It pins the WIRING only — that the
    // sweep is called at activation and its result reported — without pinning
    // exact formatting, so a reflow of the statement (line wrap, spacing) can't
    // break this for no behavioral reason. What the sweep decides, and what it
    // is allowed to signal, are behavioural and are pinned where they can
    // actually run: `worktreeServers.test.ts` (real detached processes) and
    // `serverIdentity.test.ts`.
    expect(source).toMatch(/reapStaleServers\(localStore[,{]/);
    expect(source).toMatch(/reapStaleServers\(localStore[,{][\s\S]{0,200}?logger\.info\(\s*describeReap\(/);
  });

  // A ticket's graph byte subtree and gate console-log dir are removed on hard
  // delete, but bytes can outlive the delete that should have removed them — a
  // delete that predates this fix, a foreign removal, an absent project at
  // delete time. Both live in global storage outside every worktree, so like
  // `reapStaleServers` the net must be an ACTIVATION sweep, and like every
  // activation sweep it is reported, never silent. The wiring is pinned here:
  // the two sweeps run with the SAME store predicate, and every removed byte
  // names itself on the output channel.
  it('reaps orphaned graph byte subtrees and artifact console-log dirs on activation, and says which it removed', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // The graph sweep resolves the ticket predicate from the shared store — a
    // subtree is removed when its ticket is gone from its project or its every
    // graph run is closed.
    expect(source).toContain('reapClosedGraphSubtrees(');
    expect(source).toMatch(/getProjectBySlug\(localStore, projectSlug\)/);
    expect(source).toMatch(/allGraphRunsClosed\(localStore\.db, ticketId\)/);
    expect(source).toMatch(/logger\.info\(\s*describeGraphReap\(/);
    // The artifact-dir sweep reuses the same liveness reading and reports each
    // removed dir on the output channel.
    expect(source).toContain('reapOrphanedArtifactDirs(');
    expect(source).toMatch(/logger\.info\(\s*describeArtifactReap\(/);
  });

  // The delete command wires the byte halves of permanent delete through the
  // runtime lifecycle: the graph byte root (the window project's subtree) and
  // the artifact console-log root. Without the graph root, a hard delete leaves
  // graph snapshots/workspaces that only a later sweep (or nothing) cleans.
  it('passes the graph byte root and the artifact root from the delete command', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toMatch(/graphBytesRoot:\s*[^,}\n]+,/);
    expect(source).toContain("artifactsRoot: join(context.globalStorageUri.fsPath, 'artifacts')");
  });

  it('reconciles terminals VS Code revives after the activation scan', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'extension.ts'),
      'utf8',
    );

    // The one-shot scan cannot see a tab restored a moment later; without this
    // subscription that tab stays invisible and recovery launches a duplicate.
    expect(source).toContain('vscode.window.onDidOpenTerminal(async (terminal) => {');
    expect(source).toContain('sessions.adoptLateSession(session, classifyLateSession)');
  });

  // A graph session's transport registry is in-memory and recreated fresh on
  // activation, while the terminal survives the reload. Without a re-attach the
  // "the coordinator re-attaches it on the next sweep" message is a promise
  // nothing keeps: `openSession` reports "session not attached" and the graph
  // sits stalled with no interaction path. The wiring is pinned here: the
  // coordinator re-attaches revived graph sessions on activation AND on each
  // PR sweep, and `openSession` re-attaches before reporting "not attached".
  it('re-attaches revived graph sessions on activation, on the sweep, and before the not-attached message', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const transportSource = readFileSync(
      join(process.cwd(), 'src', 'approaches', 'graph', 'transport', 'supervisedCliTransport.ts'),
      'utf8',
    );

    // The transport can register a session without spawning a second agent.
    expect(transportSource).toContain('adopt(session: SupervisedAgentSession): void;');
    // The pure resolver gates on the same adoption rule as the entry-point matrix.
    expect(source).toContain('reattachableSessionIdentity(');
    // The coordinator sweep re-attaches on every tick, and AWAITS it so the
    // reconcile that follows cannot judge a revived session before it is
    // re-registered (a race that reads a live node as dead)…
    expect(source.indexOf('await reattachGraphSessions();')).toBeLessThan(
      source.indexOf('activeGraphRunIds(gs.db, { projectId: project.id })'),
    );
    // …and openSession re-attaches BEFORE showing the "not attached" message.
    expect(source).toMatch(/if \(!session\) await reattachGraphSessions\(\);/);
    expect(source).toContain('its session is not attached to this window');
  });

  it('directs a graph run awaiting its impl marker to the guarded marker command', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain("activeGraph.status === 'completed-awaiting-impl-marker'");
    expect(source).toContain('karst stage impl pass');
    expect(source.indexOf("activeGraph.status === 'completed-awaiting-impl-marker'")).toBeLessThan(
      source.indexOf("if (!options.providerReady && !guardCapability('sessions', ticketId)) return;"),
    );
  });

  // Reattach only revives a session whose terminal SURVIVED a reload; a run
  // whose session DIED outright (dead process, no terminal) is the remaining
  // hole. The reconcile crash matrix decides the death and the host relaunches
  // the planner on the SAME planning run — and the PR sweep reconciles EVERY
  // run (after reattach, before the running-run tick) so a death mid-session is
  // recovered on the next sweep, not only at the next activation. Pinned as
  // source like every wiring case in this file: the seam is bound and the sweep
  // walks runs through the SAME wrapper the activation pass uses, so a
  // reconcile-created block still reaches `settleGraphRun`.
  it('binds the planner relaunch seam and reconciles every run on the sweep', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // The driver's relaunch is imported and invoked from a host closure that
    // captures the launch identity for the terminal-close fallback…
    expect(source).toContain('relaunchBootstrapPlanner,');
    expect(source).toContain('relaunchBootstrapPlanner(graphDriverDeps(), { graphRunId })');
    expect(source).toContain('attachPlannerCloseFallback(result.session, identity)');
    expect(source).toContain('KARST_GRAPH_PROJECT: String(identity.projectId)');
    expect(source).toContain('KARST_GRAPH_ARTIFACT_ROOT: identity.artifactRoot');
    // …the reconcile deps bind the `relaunchPlanner` seam to that closure…
    expect(source).toMatch(
      /relaunchPlanner:\s*\(graphRunId\) => void relaunchBootstrapPlannerHost\(graphRunId\)/,
    );
    // …the deps are ONE construction, reached only through the shared
    // `reconcileGraphRuns` wrapper (the activation pass and the sweep both call
    // it, so neither can drift from the other or skip `settleGraphRun`)…
    expect(source.match(/graphReconcileDeps\(\)/g)).toHaveLength(1);
    expect(source).toContain('if (result.status === \'blocked\') {');
    expect(source).toContain('settleGraphRun(gs.db, graphRunId);');
    // …the wrapper reconciles runs scoped to this window's project and
    // filtered to non-terminal statuses (G1b) — the registry is shared by
    // every IDE window, and a `closed` run has nothing left to reconcile.
    expect(source).toContain(
      'reconcilableGraphRunIds(gs.db, { projectId: project.id })',
    );
    expect(source).not.toContain("SELECT id FROM approach_graph_runs ORDER BY id");
    // …with the seam present BEFORE the running-run tick loop.
    expect(source.indexOf('relaunchPlanner:')).toBeLessThan(
      source.indexOf('activeGraphRunIds(gs.db, { projectId: project.id })'),
    );
    // The reconcile pass runs on its OWN cadence (INFO-6), separate from the
    // coordinator tick's reattach/activation loop — both still run once at
    // activation, independent of each other.
    expect(source).toContain('await reconcileGraphRuns();');
    expect(source).toContain('void runGraphSweep();');
    expect(source).toContain('void runGraphReconcileSweep();');
    expect(source).toContain('setInterval(() => void runGraphSweep(), GRAPH_SWEEP_INTERVAL_MS)');
    expect(source).toContain(
      'setInterval(() => void runGraphReconcileSweep(), GRAPH_RECONCILE_INTERVAL_MS)',
    );
  });

  // A process run is opened durably before the process starts, so a run whose
  // extension host died mid-flight stays `running` forever unless something
  // sweeps it — and a run killed by process death is the exact evidence the
  // inside view must not present as in-flight. The activation sweep is the only
  // place every window's shared registry gets that sweep, so the wiring is
  // pinned here: without it a destroyed process reads `running` until the run
  // is superseded or the data is read by hand.
  it('sweeps process runs whose host died on activation, and says which it marked stale', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // A source assertion, like every case in this file: `extension.ts` imports
    // `vscode` and cannot load under vitest. It pins the WIRING only — that the
    // sweep is called at activation with the same liveness probe as the
    // gate-run sweep and its result reported — without pinning exact
    // formatting. What the sweep decides, and what it is allowed to signal,
    // are behavioural and are pinned where they can actually run:
    // `processRuns.test.ts`.
    expect(source).toMatch(/reconcileProcessRuns\(localStore, pidAlive\)/);
    expect(source).toMatch(
      /reconcileProcessRuns\(localStore, pidAlive\)[\s\S]{0,80}?logger\.info\(\s*describeStaleProcessRun\(/,
    );
  });

  // A ship killed by a dead host freezes the ticket at `ship` reading
  // `running` forever: no awaiting-merge block for the merge sweep, no
  // stage_runs row for the drive sweep, no button for a running row — and the
  // saga built to be re-run is never re-run. The activation sweep is the only
  // place every window's shared registry can resume it, so the wiring is
  // pinned here: liveness-gated read + resume through the SAME seam as the
  // confirm-ship click (one seam, never a second run body).
  it('resumes a stranded ship on activation, through the same seam as the click', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // The READ that finds stranded ships, with the same liveness probe as the
    // gate-run and process-run sweeps.
    expect(source).toMatch(/listStrandedShipTickets\(\s*localStore,\s*pidAlive/);
    expect(source).toMatch(/logger\.info\(\s*describeStrandedShip\(/);
    // Each stranded ship resumes the saga from the activation sweep…
    expect(source).toMatch(/runShipSaga\(stranded\.ticketId\)/);
    // …and the confirm-ship click runs the saga through the same seam, adding
    // only the capability guard and the failure toast.
    expect(source).toMatch(/void runShipSaga\(ticketId\)\.catch/);
    expect(source).not.toMatch(/void runShipTicket\(/);
  });

  // A dead ship run is ALSO recovered by parking, not just resume: the
  // reconcile sweep closes a run whose host died and parks the stage `failed`
  // (the "Retry ship" surface), which runs BEFORE the stranded resume above so
  // a parked ticket is never ALSO auto-resumed. Pinned like every other
  // activation sweep: without the wiring, a dead run would only ever be
  // recovered by the resume path — or by neither, if the block is dropped.
  it('parks ship runs whose host died on activation, and says which it closed', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toMatch(
      /reconcileShipRuns\(localStore, pidAlive[\s\S]{0,80}?logger\.info\(\s*describeStaleShipRun\(/,
    );
    // The park sweep must run before the stranded resume, or a dead run whose
    // stage was parked `failed` would read as a ticket that still needs one.
    expect(source.indexOf('reconcileShipRuns(localStore, pidAlive')).toBeLessThan(
      source.indexOf('listStrandedShipTickets('),
    );
  });

  it('identifies restored terminals by pid, which a reload does not strip', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'extension.ts'),
      'utf8',
    );

    // A reattached terminal reports no launch env, so the pid captured at
    // creation is the only surviving terminal→ticket link. Capture it, and
    // resolve every revived terminal's pid BEFORE the adoption scan runs —
    // otherwise the scan sees nothing and recovery launches a second agent.
    expect(source).toContain('identity.remember(terminal, opts.env, opts.identity)');
    expect(source).toContain(
      'vscode.window.terminals.map((terminal) => terminalIdentity.resolve(terminal))',
    );
    expect(source).toContain('await terminalIdentity.resolve(terminal);');
    expect(source).toContain('restoredSessionOf(terminal, terminalIdentity)');
    expect(source).toContain('getSessionLaunchIntent(localStore, launchId)');
    // A pid outlives the process that held it; a record that outlives its
    // terminal would hand the next owner of that pid to the wrong ticket.
    expect(source).toContain('vscode.window.onDidCloseTerminal((terminal) => {');
    expect(source).toContain('terminalIdentity.forget(named.ticketId)');
  });

  it('does not run project recovery from an unbound startup window', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'extension.ts'),
      'utf8',
    );

    expect(source).toContain(
      'const startupProject = currentProject();\n  if (startupProject)',
    );
    expect(source).toContain(
      'const project = currentProject();\n    if (!project) return;',
    );
  });

  it('binds dashboard agent switching to the header selection, host confirmation, and the normal launch path', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    expect(source).toContain('applyAgentSwitchSelection(');
    expect(source).toMatch(
      /fixExecutionActive: listRecoveryRounds\(localStore, ticketId\)\s*\.some\(\(round\) => round\.status === 'fixing'\)/,
    );
    expect(source).toContain('modal: true');
    expect(source).toContain("guardProviderCapabilityAsync('sessions', provider)");
    expect(source).toContain(
      "if (!options.providerReady && !guardCapability('sessions', ticketId)) return;",
    );
    expect(source).toContain('sessions.disposeSession(ticketId)');
    expect(source).toContain("vscode.commands.executeCommand('karst.openSession', ticketId, options)");
    expect(source).toContain("logError('agent session switch failed', error)");
    expect(source).toContain(
      'finally {\n      provider.refresh();\n      dashboard.pushState(ticketId);\n      showStatusFor(ticketId);\n    }',
    );
  });

  it('keeps evidence status visible in the bounded-evidence Quick Pick', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    expect(source).toContain('row.status');
    expect(source).toContain('statusLabel');
  });

  // Task 8 wiring: the Tester and Review AI processes and the verifier gate
  // runner must be reachable from the extension composition root — a stage
  // that passes its focused unit tests while the host never resolves its
  // processes into `driveTicket` is exactly the wiring gap this pins. The
  // resolvers compose the SAME `instrument(resolveAdapter(...))` path
  // `wiring.test.ts` scans, so instrumentation stays centralized.
  it('wires the resolved Tester and Review processes and the verifier runner into the driver', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain("uatTester: (id) => processFor(id, 'uat-tester')");
    expect(source).toContain("reviewProcess: (id) => processFor(id, 'review')");
    expect(source).toContain('runVerifier: runProcess');
    expect(source).toContain('resolveProcessAssignment(');
    expect(source).toContain('currentManifest() ?? emptyManifest(),');
    expect(source).toMatch(/model: t\.model \|\| undefined,\s*effort: t\.effort \|\| undefined,\s*},\s*modelCatalog,\s*\)/);
    expect(source).toContain(
      'adapter: instrument(resolveAdapter(assignment.provider), assignment.provider)',
    );
    expect(source).not.toContain('adapter: currentAgentAdapter(ticketId)');
  });

  // Task 3: EVERY configured inside process role must be executable from the
  // extension composition root — the ticket-form analyzer, the Tester, the
  // Review findings process, the two Fix roles (resolved by the gate that
  // failed) and the PR-description process. The null collapse used to be
  // type-asserted at this seam; the callbacks now return
  // `DriveProcessBundle | null` natively.
  it('wires every configured inside process role, with no null-collapse type assertion at the seam', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain("processFor(ticketId, 'uat-fix')");
    expect(source).toContain("processFor(ticketId, 'review-fix')");
    expect(source).toContain("processFor(ticketId, 'pr-description')");
    // The ticket form's analyzer is its own process role, resolved through the
    // same seam (869edcm45 follow-up).
    expect(source).toContain("processFor(ticketId, 'ticket-analysis')");
    expect(source).toContain('resolveAnalysisProcess: analysisProcess');
    // The seam's callbacks return `DriveProcessBundle | null` natively — the
    // old host-side null collapse is gone (the needle is split so the residual
    // guard in Task 7 stays clean).
    const seamAssertion = ['undefined as unknown as', 'DriveProcessBundle'].join(' ');
    expect(source).not.toContain(seamAssertion);
    expect(source).toContain('DriveProcessBundle');
  });

  // The ticket form's analysis runs through the SETTINGS Ticket-analysis
  // assignment: when the row names a profile (`processes.ticketAnalysis.agent`),
  // the execution boundary must resolve the profile's BODY and overlay it as
  // the assignment's `instructions` — the ONLY prompt source now that the
  // inline `processes.<key>.instructions` override is retired
  // (replacing the built-in analyzer role block). Without this wiring the
  // selected Settings agent makes no difference to the ticket analysis — the
  // reported bug. The overlay lives at the shared `processFor` seam, so the
  // same rule wires UAT / Review / Fix, not just the analyzer.
  it('overlays the assigned Settings profile body as the process instructions at the processFor seam', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // The seam reads the assignment's PROFILE reference (not the ticket's
    // single-subagent pick) and resolves its body…
    expect(source).toMatch(/assignment\.agent/);
    expect(source).toMatch(/soloAgentBody\(assignment\.agent\)/);
    // …with no second source able to outrank it: the retired inline override
    // must not come back as a branch here.
    expect(source).not.toMatch(/assignment\.instructions !== undefined/);
    // …and the resolved body is layered onto the assignment as `instructions`.
    expect(source).toContain('{ ...assignment, instructions }');
    // Only the prompt-BEARING roles resolve a body, and that vocabulary is the
    // shared one — never a literal re-declared here.
    expect(source).toContain('new Set<ProcessRole>(PROMPT_BEARING_ROLES)');
    // The wrong #170 seam is gone: the ticket's own single-subagent pick never
    // hijacks the headless analysis (it drives the SESSION).
    expect(source).not.toContain('assignment: { ...bundle.assignment, instructions: body }');
  });

  // Task 3: a configured-ABSENT Fix process (enabled: false) must never reach
  // the session manager — no nudge, no launch, no fabricated process evidence —
  // and a live session whose identity differs from the configured Fix
  // assignment must be retired through the normal session-switch lifecycle and
  // relaunched through the explicit assignment override, never relabeled.
  it('refuses a disabled Fix process at the session seam and launches differing identities through the assignment override', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain('configured Fix process disabled');
    expect(source).toMatch(/if \(process === null\) \{\s*logger\.info\s*\(/);
    expect(source).toContain('sessions.disposeSession(ticketId)');
    expect(source).toContain('assignment: process.assignment');
    // The override resolves the launch adapter from the assignment's provider —
    // the ticket/manifest precedence is bypassed, never consulted.
    expect(source).toContain('resolveAdapter(options.assignment.provider)');
  });

  // A fix that can never start (disabled process, unprobeable core) or a fix
  // whose session died without the marker must park the fix STAGE ROW — the
  // machine enters fix `running`, and nothing re-read it before, so a ticket
  // resting at fix for a human kept claiming the agent was actively fixing.
  it('parks the fix stage row whenever the host leaves a ticket at fix with no execution', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain('parkFixStage(localStore, ticketId, FIX_PARKED_PROCESS_UNAVAILABLE');
    expect(source).toContain("!hasFixingRound(localStore, ticketId) &&\n          parkFixStage(localStore, ticketId, FIX_PARKED_NO_EXECUTION");
    expect(source).toContain('the configured Fix process is disabled');
    expect(source).toContain('the configured Fix core is not available');
    expect(source).toContain('its session closed with no fix');
  });

  it('delegates configured Fix compatibility so only replacement paths probe before disposal or launch', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const fixStart = source.indexOf('function resumeFixSession(');
    const fixEnd = source.indexOf('// The §5.4-safe driver nudge', fixStart);
    const fix = source.slice(fixStart, fixEnd);

    expect(fix).toContain('resumeConfiguredFixExecution(localStore, {');
    expect(fix).toContain('sessionIdentity: () => sessions.sessionIdentity(ticketId)');
    expect(fix).toContain(
      "guardProviderCapability('sessions', process.assignment.provider)",
    );
    expect(fix).toContain('dispose: () => sessions.disposeSession(ticketId)');
    expect(fix).toContain('providerReady: true');
  });

  // The create-ticket API lands tickets on THIS window's project (the DB is
  // shared by every window), and a created ticket must appear in the sidebar
  // without anyone opening the form. Pinned as source like every wiring case
  // in this file: extension.ts imports `vscode` and cannot load under vitest.
  it('wires the ticket API to the window project and a sidebar refresh', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain('ticketApi: {');
    expect(source).toContain('projectId: () => currentProject()?.id,');
    expect(source).toContain('onTicketCreated: (ticketId) => {');
  });

  // A graph run stuck at `planning` whose bootstrap planner process is dead
  // was never reconciled: `reconcileGraphRun` swept node runs only, and a
  // `planning` run has no node runs — so the ticket sat at impl forever. The
  // reconcile now sweeps the bootstrap planner run (dead → planner `stale` +
  // run blocked recoverably), the reconcile wrapper writes the blocked run's
  // `approach-graph-failed` stage block, and the typed recovery relaunches a
  // fresh bootstrap planner on the SAME graph run, which the host launches.
  // Pinned as source: extension.ts imports `vscode` and cannot load under
  // vitest. The decision logic is pinned in reconcile.test.ts and
  // recovery.test.ts; this pins the WIRING.
  it('reconciles a dead bootstrap planner, settles its stage block, and wires the bootstrap relaunch', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // The reconcile wrapper settles a run this pass blocked (node OR planner),
    // writing the stage block the dashboard's graph-recovery Resume reads.
    expect(source).toMatch(/if \(result\.status === 'blocked'\) \{\s*settleGraphRun\(gs\.db, graphRunId\);/);
    // The recovery's `relaunched` result is handled in BOTH resume paths and
    // launches a fresh bootstrap planner through a dedicated host binding.
    expect(source).toContain("if (recovery.kind === 'relaunched' && recovery.launch) graphBootstrapRelaunch(recovery.launch);");
    expect(source).toContain('const launchBootstrapRelaunchHost = async (launch: BootstrapRelaunchRequest)');
  });

  it('refreshes and wakes recovered graph work, while describing blocked Stop accurately', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain('onGraphRecovered(ticketId, graphRunId);');
    expect(source).toContain('provider.refresh();\n      dashboard.pushState(ticketId);\n      void driveGraphRunContinuation(graphRunId);');
    expect(source).toContain('void driveGraphRunContinuation(graphRunId);');
    expect(source).toContain('result.drained || result.terminated > 0');
  });

  it('refreshes and wakes every successful graph recovery from the legacy resume-stage route', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const start = source.indexOf('resumeStage: (ticketId, stageKey) => {');
    const end = source.indexOf('openFullEvidence:', start);
    const resumeStage = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resumeStage).toContain('onGraphRecovered(ticketId, outcome.graphRunId);');
  });
});
