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
});
