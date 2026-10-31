import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectPalette } from '../../model/palette.js';
import { injectProviderIdentity } from '../../model/providerIdentity.js';
import { injectAgentIdentity } from '../../model/agentIdentity.js';
import { injectServerLogsView } from '../../model/serverLogsView.js';
import { injectWebviewSend } from '../../model/webviewSendInjector.js';
import { decodeAnsi } from './logLine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'webview.html'), 'utf8');
const appFile = (name: string): string => readFileSync(join(HERE, 'app', name), 'utf8');
const SERVER_LOGS_JS = readFileSync(join(HERE, '..', '..', 'model', 'serverLogsView.webview.js'), 'utf8');
const SERVER_LOGS_CSS = readFileSync(join(HERE, '..', '..', 'model', 'serverLogsView.webview.css'), 'utf8');

/**
 * The dashboard webview hydrated exactly as the host renders it (design system, palette, provider and agent identity,
 * the shared server-logs runtime, the typed senders): what the shared-surface guards below read.
 */
const HYDRATED = injectWebviewSend(
  injectServerLogsView(
    injectAgentIdentity(injectProviderIdentity(injectPalette(injectDesignSystem(HTML)))),
  ),
);

/**
 * The shared server-logs surface (Task 3): the control strip, the ANSI
 * rendering and the wiring between the dashboard and the shared factory. The
 * dashboard no longer owns the surface — it owns the open flag and the host
 * request — so the controls are asserted where they actually live, in the
 * injected runtime, and the decoder is pinned to `logLine.ts`'s.
 */
describe('shared server logs surface', () => {
  it('carries the control strip the shared runtime renders', () => {
    for (const hook of [
      'id="logsSearch"',
      'data-log-filter',
      'data-log-current-run',
      'data-log-clear',
      'data-log-detach',
      'data-log-prev',
      'data-log-next',
      'id="logsHost"',
    ]) {
      expect(HYDRATED, `missing logs control: ${hook}`).toContain(hook);
    }
  });

  it('omits Open in Window when the factory is detached', () => {
    // The standalone panel has no second window to open, so the control is
    // conditional on the factory option rather than always rendered.
    expect(SERVER_LOGS_JS).toMatch(/detached \? ''[\s\S]*?data-log-detach/);
  });

  it('wires the dashboard to the shared factory, not a private surface', () => {
    expect(HTML).toContain('/*KARST_SERVER_LOGS_VIEW_CSS*/');
    expect(HTML).toContain('/*KARST_SERVER_LOGS_VIEW_JS*/');
    // The React wrapper (app/ServerLogsView.tsx) drives the runtime; the page only carries the injection markers.
    const wrapper = appFile('ServerLogsView.tsx');
    expect(wrapper).toContain('createServerLogsView');
    expect(wrapper).toContain('.open()');
    expect(wrapper).toContain('.handleInitial(');
    expect(wrapper).toContain('.handleOutput(');
    expect(HTML).not.toContain('logsViewInstance');
    // The old inline surface is gone wholesale, not merely unused.
    expect(HTML).not.toContain('renderLogsContent');
    expect(HTML).not.toContain('logsMergedLines');
  });

  it('posts server-logs-detach from the shared control, and no unreachable host action', () => {
    expect(SERVER_LOGS_JS).toContain("{ type: 'server-logs-detach' }");
  });

  it('ships CSS rules for every class the decoder emits (UI-R10)', () => {
    // The ANSI classes are only in the DOM once lines render, so the load-time
    // RUNTIME sweep cannot check them — this pins their rules here.
    for (const cls of ['k-ansi-fg-green', 'k-ansi-bg-red', 'k-ansi-fg-bright-white', 'k-ansi-bold']) {
      expect(SERVER_LOGS_CSS, `no rule for ${cls}`).toContain('.' + cls);
    }
    expect(SERVER_LOGS_CSS).toContain('.k-loghit');
  });

  it('clear() drops the lines and re-renders, posting nothing', () => {
    const from = SERVER_LOGS_JS.indexOf('function clear()');
    const to = SERVER_LOGS_JS.indexOf('function handleInitial');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = SERVER_LOGS_JS.slice(from, to);
    expect(body).toMatch(/lines = \[\];/);
    expect(body).toContain('renderContent();');
    expect(body, 'clear must never reach the host — tailing continues').not.toContain('post(');
  });

  it('matches every occurrence case-insensitively by splitting the escaped text on the escaped query', () => {
    const from = SERVER_LOGS_JS.indexOf('function highlight');
    const body = SERVER_LOGS_JS.slice(from, from + 700);
    expect(body).toContain('esc(text)');
    expect(body).toContain('esc(query)');
    expect(body).toContain('class="k-loghit"');
    // Escaped-then-split, never a regex over unescaped input.
    expect(body).not.toMatch(/new RegExp|\.replace\(/);
  });

  /**
   * Mirrored TS→HTML constants ARE behavior (UI-INVARIANTS.md): the shipped JS
   * decoder must agree with the tested TS one, or the surface renders one thing
   * while `logLine.ts` claims another. The assertion evaluates the FILE'S OWN
   * TEXT — never a second decoder fabricated in the test.
   */
  it('the ported decoder and logLine.ts agree on an ANSI line', () => {
    const sandbox: Record<string, unknown> = { window: {} };
    runInNewContext(SERVER_LOGS_JS, sandbox);
    const ported = sandbox.KARST_SERVER_LOGLINE as {
      decodeAnsi: (text: string) => Array<{ text: string; classes: string[] }>;
    };
    expect(ported, 'the shared file does not expose KARST_SERVER_LOGLINE').toBeTruthy();
    const input = '\u001b[32mok\u001b[39m';
    const portedSegments = ported.decodeAnsi(input);
    const tsSegments = decodeAnsi(input);
    expect(portedSegments.map((s) => ({ text: s.text, classes: s.classes }))).toEqual(
      tsSegments.map((s) => ({ text: s.text, classes: s.classes })),
    );
    expect(portedSegments[0]!.classes).toContain('k-ansi-fg-green');
  });

  it('drillHead swaps the runtime title and Close for the slot the dashboard header fills; tabs stay runtime state', () => {
    expect(SERVER_LOGS_JS).toContain("o.drillHead === true");
    expect(SERVER_LOGS_JS).toContain('id="logsDrillHead"');
    // A tab click only sets activeTab and re-renders: no post, so the history never sees it.
    const tabBranch = SERVER_LOGS_JS.slice(SERVER_LOGS_JS.indexOf("closest('[data-log-tab]')"), SERVER_LOGS_JS.indexOf("closest('[data-log-prev]')"));
    expect(tabBranch).not.toContain('post(');
  });
});
