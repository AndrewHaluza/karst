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
    expect(source).toContain('identity.remember(terminal, opts.env)');
    expect(source).toContain(
      'vscode.window.terminals.map((terminal) => terminalIdentity.resolve(terminal))',
    );
    expect(source).toContain('await terminalIdentity.resolve(terminal);');
    expect(source).toContain('restoredSessionOf(terminal, terminalIdentity)');
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
    expect(source).toContain('adapter: currentAgentAdapter(ticketId)');
  });

  // Task 9 (Finding 1): the Inside preview is a DEVELOPMENT-ONLY surface. The
  // command is registered only in an Extension Development Host, and the
  // fixture matrix + preview module are pulled in lazily by that branch — the
  // production dashboard/state dependency graph never imports them (pinned by
  // insidePreview.test.ts's import walk), and Production/Test never register
  // the command at all, so an unregistered/non-development path cannot open a
  // panel.
  it('registers the Inside preview command only in Development mode, with lazy imports', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toMatch(
      /if \(context\.extensionMode === vscode\.ExtensionMode\.Development\) \{[\s\S]{0,700}karst\.dev\.openInsidePreview/,
    );
    expect(source).toContain("import('./ui/dashboard/insidePreview.js')");
    expect(source).toContain("import('./ui/dashboard/insideFixtures.js')");
    // Never statically imported at runtime in the host: only the guarded
    // branch loads them (the `import type` of InsidePreviewHost is erased by
    // the compiler), so a production bundle carries neither module.
    expect(source).not.toMatch(/^import (?!type ).*inside(?:Fixtures|Preview)\.js/m);
  });

  it('contributes the preview command hidden behind the development-only context key', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      contributes?: {
        commands?: Array<{ command?: string }>;
        menus?: { commandPalette?: Array<{ command?: string; when?: string }> };
      };
    };

    const command = pkg.contributes?.commands?.find(
      (c) => c.command === 'karst.dev.openInsidePreview',
    );
    expect(command, 'package.json does not contribute karst.dev.openInsidePreview').toBeTruthy();
    const palette = pkg.contributes?.menus?.commandPalette ?? [];
    expect(palette).toContainEqual(
      expect.objectContaining({
        command: 'karst.dev.openInsidePreview',
        when: 'extensionMode == development',
      }),
    );
  });
});
