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

    expect(source).toContain('settleShipGates(localStore, { projectId: project.id })');
    expect(source).toContain('for (const id of landed) void pushDoneStatus(id, false);');
  });

  // The provider's post-delivery status used to be pushed the moment the PRs
  // opened, which is exactly the claim this ticket exists to stop making. It now
  // fires from whichever path actually moved the ticket to `done`.
  it('pushes the provider status only for a ticket that actually reached done', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    // Ship: only the nothing-to-merge case walks straight through to done.
    expect(source).toContain("if (getTicket(store, ticketId).stageCurrent === 'done') {");
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
    expect(source).toMatch(/reapStaleServers\(localStore\)/);
    expect(source).toMatch(/reapStaleServers\(localStore\)[\s\S]{0,80}?logger\.info\(\s*describeReap\(/);
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

  it('binds dashboard agent switching to native pickers, confirmation, and the normal launch path', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    expect(source).toContain('runAgentSwitchFlow(');
    expect(source).toMatch(
      /fixExecutionActive: listRecoveryRounds\(localStore, ticketId\)\s*\.some\(\(round\) => round\.status === 'fixing'\)/,
    );
    expect(source).toContain('vscode.window.showQuickPick');
    expect(source).toContain("modal: true");
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
    expect(source).toMatch(/model: t\.model \|\| undefined,\s*},\s*modelCatalog,\s*\)/);
    expect(source).toContain(
      'adapter: instrument(resolveAdapter(assignment.provider), assignment.provider)',
    );
    expect(source).not.toContain('adapter: currentAgentAdapter(ticketId)');
  });

  // Task 3: EVERY configured inside process role must be executable from the
  // extension composition root — the Tester, the Review findings process, the
  // two Fix roles (resolved by the gate that failed) and the PR-description
  // process. The null collapse used to be type-asserted at this seam; the
  // callbacks now return `DriveProcessBundle | null` natively.
  it('wires every configured inside process role, with no null-collapse type assertion at the seam', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain("processFor(ticketId, 'uat-fix')");
    expect(source).toContain("processFor(ticketId, 'review-fix')");
    expect(source).toContain("processFor(ticketId, 'pr-description')");
    // The seam's callbacks return `DriveProcessBundle | null` natively — the
    // old host-side null collapse is gone (the needle is split so the residual
    // guard in Task 7 stays clean).
    const seamAssertion = ['undefined as unknown as', 'DriveProcessBundle'].join(' ');
    expect(source).not.toContain(seamAssertion);
    expect(source).toContain('DriveProcessBundle');
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
});
