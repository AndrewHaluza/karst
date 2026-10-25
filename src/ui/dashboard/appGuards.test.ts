import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, 'app');
const appFile = (name: string): string => readFileSync(join(APP, name), 'utf8');
/** Every non-test component of the React app. */
const appComponents = (): string[] =>
  readdirSync(APP, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) && !f.includes('fixtures'))
    .map((f) => appFile(f));

/**
 * Text-level guards on the React app's source that no behavioural test can express: vocabulary that must stay inside the
 * host's validated set, bounds on static strings, a pinned logo path, and cascade-order facts of the moved CSS. The app's
 * structure (one acquisition, no host-module imports, raw HTML only in `Icon.tsx`) is `app/architecture.test.ts`.
 */
describe('dashboard app source guards', () => {
  it('emits no action the host does not validate', () => {
    const declared = readFileSync(join(HERE, 'messages.ts'), 'utf8');
    // The names that are NOT host messages are webview-local: the control opens a surface or flips view state and never
    // posts a message of that name (any posting happens in the overlay stack, as `stage-log-request` for the console).
    const LOCAL = new Set([
      'console',
      'preview-ticket-data', 'toggle-base-form', 'toggle-rebase-switch', 'artifact-findings-repo', 'toggle-graph-view',
      'baseline-view', 'baseline-reject-open', 'baseline-reject-cancel',
      'server-logs-request', 'env-overrides-open',
    ]);
    const emitted = appComponents()
      .flatMap((text) => [...text.matchAll(/data-act="([a-z][a-z-]*)"/g)].map((m) => m[1]!))
      .filter((act) => !LOCAL.has(act));
    expect(emitted.length).toBeGreaterThan(0);
    for (const act of new Set(emitted)) {
      expect(declared, `unvalidated action: ${act}`).toContain(`'${act}'`);
    }
    expect(emitted).not.toContain('switch-agent');
    // No control posts stop-driver: it stays unreachable from the rendered UI until a control is designed for it.
    expect(emitted).not.toContain('stop-driver');
  });

  it('never lets the webview choose the merge strategy', () => {
    // The method is the host's question to the user (a modal), so no strategy flag may appear in a posted message.
    const sources = appComponents().join('\n');
    expect(sources).not.toContain('--squash');
    expect(sources).not.toMatch(/method:\s*'(squash|merge|rebase)'/);
  });

  it('keeps every STATIC title within the 80-character bound (UI-R20)', () => {
    // Excludes titles built from an interpolated template literal: their rendered length depends on runtime data (a PR
    // number, a base ref name), so a character count on the source text checks the wrong thing.
    const titles = appComponents()
      .flatMap((text) => [...text.matchAll(/title="([^"][^"]*)"/g)].map((m) => m[1]!))
      .filter((t) => !t.includes('${'));
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t.length, `title too long (${t.length} chars): "${t}"`).toBeLessThanOrEqual(80);
    }
  });

  it('renders the CURRENT karst mark in the artifact origin chip — never the retired three-node graph', () => {
    // It must match the approved monochrome silhouette (media/karst-mark.svg, pinned by brandAssets.test.ts).
    const chips = appFile('ArtifactChips.tsx');
    expect(chips).toMatch(/viewBox="0 0 215 215"/);
    expect(chips).toMatch(/M 96 20[\s\S]*M 151 42[\s\S]*cx="106\.5" cy="111\.5" r="26\.5"/);
    expect(chips).not.toMatch(/cx="6" cy="6" r="2\.4"/);
    expect(chips).not.toMatch(/7\.6 7\.6/);
  });

  it('gives both log surfaces a reachable scrollback: a visible thumb and the paging keys', () => {
    // Both had an invisible thumb over the console ground. PageUp/PageDown/Home/End drive both surfaces (xterm takes no
    // stdin here).
    expect(appFile('ServerLogsView.css')).toMatch(/\.logsview \.loghost\{[^}]*overflow-y:auto/);
    expect(appFile('ServerLogsView.css')).toMatch(/\.logsview \.loghost::-webkit-scrollbar-thumb\{/);
    expect(appFile('Terminal.css')).toMatch(/\.termview \.xterm-viewport::-webkit-scrollbar-thumb\{/);
    expect(appFile('TerminalView.tsx')).toMatch(/function scrollByKey[\s\S]*?term\.scrollPages\(-1\)/);
    expect(appFile('ServerLogsView.tsx')).toMatch(/function scrollLogsByKey[\s\S]*?host\.scrollTop -= page/);
  });

  it('never covers the dashboard at load — .hidden beats .termview display:flex', () => {
    // #termView starts with BOTH classes and the console box is position:fixed;inset:0 with an opaque background: if its
    // own display:flex ever beat .hidden{display:none}, EVERY dashboard open would show a blank full-screen box. Equal
    // specificity, so the override must follow the .termview block; a text assertion pins the rule and its order.
    const css = appFile('Terminal.css');
    expect(css).toMatch(/\.termview\{[^}]*display:flex/);
    expect(css).toMatch(/\.termview\.hidden\{display:none\}/);
    expect(css.indexOf('.termview.hidden')).toBeGreaterThan(css.indexOf('.termview{'));
  });
});
