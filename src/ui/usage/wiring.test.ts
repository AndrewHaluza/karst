import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXTENSION = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};
const COPY_ASSETS = readFileSync(join(ROOT, 'scripts', 'copy-assets.mjs'), 'utf8');

/**
 * Source-level guards on the host wiring, which no unit test can reach: the
 * modules below are all `vscode`-importing and do not load under vitest.
 *
 * The load-bearing one is the LAST: instrumentation is centralized only for as
 * long as every adapter handed to a consumer goes through `instrument`. A future
 * `resolveAdapter(...)` added beside these two would compile, run, and silently
 * record nothing — the exact failure the wrapper exists to make impossible.
 */
describe('token-usage host wiring', () => {
  it('declares the command that opens the view', () => {
    expect(PKG.contributes.commands.map((c) => c.command)).toContain('karst.openTokenUsage');
  });

  it('registers that command against the panel manager', () => {
    expect(EXTENSION).toContain(
      "vscode.commands.registerCommand('karst.openTokenUsage', () => tokenUsagePanel.open())",
    );
    expect(EXTENSION).toContain('new UsagePanelManager(');
  });

  it('scopes the panel to the bound project — the DB is shared by every window', () => {
    expect(EXTENSION).toMatch(/UsagePanelManager\([\s\S]{0,200}projectId: \(\) => currentProject\(\)/);
  });

  it('ships the webview into dist — an uncopied asset fails only at runtime', () => {
    expect(COPY_ASSETS).toContain("'ui/usage/webview.html'");
  });

  it('records through the store, in one place', () => {
    expect(EXTENSION).toContain('sink: { record: (entry) => recordTokenUsage(localStore, entry) }');
  });

  it('instruments EVERY adapter it hands out', () => {
    const resolved = [...EXTENSION.matchAll(/resolveAdapter\([^)]*\)/g)].map((m) => m[0]);
    // Two call sites today: the per-ticket adapter and the ticket form's.
    expect(resolved.length).toBeGreaterThan(0);
    for (const call of resolved) {
      const line = EXTENSION.split('\n').find((l) => l.includes(call!));
      expect(line, `un-instrumented adapter: ${call}`).toMatch(/instrument\(resolveAdapter/);
    }
  });
});
