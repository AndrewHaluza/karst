import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXTENSION = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};
const COPY_ASSETS = readFileSync(join(ROOT, 'scripts', 'copy-assets.mjs'), 'utf8');
const QUOTA_OPS = readFileSync(join(ROOT, 'src', 'extension', 'ops', 'quotaOps.ts'), 'utf8');

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
    expect(EXTENSION).toContain("vscode.commands.registerCommand('karst.openTokenUsage'");
    expect(EXTENSION).toMatch(/karst\.openTokenUsage'[\s\S]{0,120}tokenUsagePanel\.open\(arg === 'quota' \? 'quota' : 'spend'\)/);
    expect(EXTENSION).toContain('new UsagePanelManager(');
  });

  it('scopes the panel to the bound project — the DB is shared by every window', () => {
    expect(EXTENSION).toMatch(/UsagePanelManager\([\s\S]{0,400}projectId: \(\) => currentProject\(\)/);
  });

  it('wires the per-core quota service, status bar and launch warning', () => {
    // One service, real readers, disposed with the window.
    expect(EXTENSION).toContain('new QuotaService(');
    // The D185 opt-in consent closure is live on every poll, so a Settings
    // toggle reaches the reader without a reload — never a captured boolean.
    expect(EXTENSION).toContain('readers: defaultQuotaReaders({');
    expect(EXTENSION).toMatch(
      /claudeOauthUsageApi: \(\) => currentManifest\(\)\?\.quota\?\.claudeOauthUsageApi === true/,
    );
    expect(EXTENSION).not.toContain('opencode2AuthPath');
    expect(EXTENSION).toMatch(/quotaService\.start\(\)/);
    expect(EXTENSION).toMatch(/quotaOps\.dispose\(\); quotaService\.dispose\(\)/);
    // The status badge opens the Quota tab.
    expect(EXTENSION).toMatch(/quotaStatus\.command = \{[\s\S]{0,80}command: 'karst\.openTokenUsage',[\s\S]{0,40}arguments: \['quota'\]/);
    // The decision half lives in the host-agnostic ops module; the binding is thin.
    expect(EXTENSION).toContain('new QuotaOps(');
    expect(EXTENSION).toMatch(/if \(!options\.recovery && quotaLine === undefined\) quotaOps\.warnBeforeLaunch\(launchProvider, accountForLaunch\(launchProvider, resumeId, options\.account\)\)/);
    // The ops module owns the badge/warning decisions (and is unit-tested).
    expect(QUOTA_OPS).toContain('buildQuotaIndicator(');
    expect(QUOTA_OPS).toContain('quotaLaunchWarning(');
  });

  it('refreshes open usage surfaces when an interactive token delta lands', () => {
    expect(EXTENSION).toMatch(
      /if \(payload\.hook_event_name === 'UsageUpdate'\) \{\s*tokenUsagePanel\.refresh\(\);\s*dashboard\.pushStoreState\(ticketId\);\s*return;\s*\}/,
    );
  });

  it('feeds a recorded token delta into the open panel, debounced and disposed with the window (US-11)', () => {
    expect(EXTENSION).toContain('onTokenUsageRecorded(');
    expect(EXTENSION).toContain('tokenUsagePanel.scheduleRefresh()');
    expect(EXTENSION).toContain('unsubscribeTokenUsage');
    expect(EXTENSION).toContain('tokenUsagePanel.dispose()');
  });

  it('wires the quota-settings, new-ticket and quota-refresh actions of the view (US-13, US-15, US-31)', () => {
    // The panel awaits these promises for the terminal action-result (UI-R13): never discard them with `void`.
    expect(EXTENSION).toMatch(/openQuotaSettings: \(\) => settings\.openAt\('#agents\/accounts'\)/);
    expect(EXTENSION).toContain("Promise.resolve(vscode.commands.executeCommand('karst.openTicketForm')).then(() => undefined)");
    expect(EXTENSION).not.toContain("void settings.openAt('#agents/accounts')");
    expect(EXTENSION).toContain('refreshQuota: () => quotaService.refresh()');
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

describe('account-block relaunch wiring', () => {
  it('relaunches under default without a second host-memory admission', () => {
    expect(EXTENSION).toMatch(/!options\.recovery && !options\.memoryAdmitted && !sessions\.isOpen\(ticketId\) && wantsSbxBackend\(/);
    expect(EXTENSION).toMatch(/account: 'default', allowResume: false, memoryAdmitted: true/);
  });
});
