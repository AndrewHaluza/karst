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
    expect(source).toContain('vscode.window.onDidOpenTerminal((terminal) => {');
    expect(source).toContain('sessions.adoptLateSession(session, classifyLateSession)');
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
    expect(source).toContain("guardProviderCapability('sessions', provider)");
    expect(source).toContain('sessions.disposeSession(ticketId)');
    expect(source).toContain("vscode.commands.executeCommand('karst.openSession', ticketId)");
    expect(source).toContain("logError('agent session switch failed', error)");
    expect(source).toContain(
      'finally {\n      provider.refresh();\n      dashboard.pushState(ticketId);\n      showStatusFor(ticketId);\n    }',
    );
  });
});
