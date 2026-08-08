import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insidePreviewFixtures, PREVIEW_REPO_COUNTS, PREVIEW_SCENARIOS } from './insideFixtures.js';
import {
  INSIDE_PREVIEW_TITLE,
  openInsidePreview,
  previewPayloadFor,
  previewStateFor,
  type InsidePreviewHost,
} from './insidePreview.js';
import type { DashboardState } from './state.js';

/**
 * Task 9 / Finding 1: the development-only Inside preview panel. The host
 * boundary (`InsidePreviewHost`) keeps every test free of a runtime `vscode`
 * import; the fixture snapshots enter the webview through the SAME
 * `{type:'state'}` message a real dashboard push uses, wrapped in a
 * host-built `DashboardState` envelope (`previewStateFor`).
 */

interface RecordedPanel {
  title: string;
  html: string;
  posted: unknown[];
}

function fakeHost(): { host: InsidePreviewHost; panels: RecordedPanel[] } {
  const panels: RecordedPanel[] = [];
  const host: InsidePreviewHost = {
    createPanel: (title, html) => {
      const panel: RecordedPanel = { title, html, posted: [] };
      panels.push(panel);
      return {
        postMessage: (message) => void panel.posted.push(message),
        onDidReceiveMessage: () => undefined,
        onDidDispose: () => undefined,
      };
    },
  };
  return { host, panels };
}

function messageTypes(panel: RecordedPanel): string[] {
  return panel.posted.map((m) => (m as { type: string }).type);
}

describe('inside preview panel', () => {
  const fixtures = insidePreviewFixtures();

  it('opens one panel, seeded with the fixture list and the first snapshot', () => {
    const { host, panels } = fakeHost();
    openInsidePreview(host, fixtures);

    expect(panels).toHaveLength(1);
    expect(panels[0]!.title).toBe(INSIDE_PREVIEW_TITLE);
    // Fixtures first, then the initial snapshot — the webview reveals the
    // toolbar on the fixtures message and renders the state through the same
    // path a real dashboard push uses.
    expect(messageTypes(panels[0]!)).toEqual(['preview-fixtures', 'state']);
  });

  it('posts no snapshot for an empty fixture list', () => {
    const { host, panels } = fakeHost();
    openInsidePreview(host, []);
    expect(messageTypes(panels[0]!)).toEqual(['preview-fixtures']);
  });

  it('embeds the host-built dashboard snapshot in every fixture payload', () => {
    const { host, panels } = fakeHost();
    openInsidePreview(host, fixtures);

    const payload = (panels[0]!.posted[0] as {
      fixtures: Array<{ id: string; state: DashboardState }>;
    }).fixtures;
    expect(payload).toHaveLength(fixtures.length);
    for (const f of fixtures) {
      const entry = payload.find((p) => p.id === f.id);
      expect(entry, `missing payload for ${f.id}`).toBeTruthy();
      // The view rides the envelope at the fixture's own stage, and the panel
      // presents that stage as current.
      expect(entry!.state.insideViews[f.stage]).toBe(f.view);
      expect(entry!.state.presentedStage).toBe(f.stage);
      expect(entry!.state.stageCurrent).toBe(f.stage);
    }
  });

  it('builds a neutral, renderable DashboardState envelope around the view', () => {
    for (const f of fixtures) {
      const state = previewStateFor(f);
      expect(state.ticketId).toBe(0);
      expect(state.rail.main).toEqual([]);
      expect(state.stepper).toEqual([]);
      expect(state.currentStage).toBeNull();
      expect(state.servers).toEqual([]);
      expect(state.worktrees).toEqual([]);
      expect(state.prs).toEqual([]);
      expect(state.mergeChecks).toEqual([]);
      expect(state.approach).toBeNull();
      expect(state.agentSession.canSwitch).toBe(false);
      expect(state.now.text.length).toBeGreaterThan(0);
      // The other five inside stages render as empty views, so every stage
      // selection in the panel resolves to a renderable shape.
      for (const key of ['scope', 'impl', 'uat', 'review', 'ship', 'done'] as const) {
        expect(state.insideViews[key].stageKey).toBe(key);
      }
    }
  });

  it('round-trips deterministically: same fixtures in, same messages out', () => {
    const a = fakeHost();
    openInsidePreview(a.host, insidePreviewFixtures());
    const b = fakeHost();
    openInsidePreview(b.host, insidePreviewFixtures());
    expect(JSON.stringify(a.panels[0]!.posted)).toBe(JSON.stringify(b.panels[0]!.posted));
  });

  it('keeps preview lifecycle controls in the dev-only toolbar and on the generic inside-progress protocol', () => {
    const webview = readFileSync(resolve(process.cwd(), 'src/ui/dashboard/webview.html'), 'utf8');
    expect(webview).toContain('data-pv-progress="active"');
    expect(webview).toContain('data-pv-progress="completed"');
    expect(webview).toContain('data-pv-progress="cleared"');
    expect(webview).toContain("type: 'inside-progress'");
  });

  // Task 6 (residual): the webview toolbar selects a fixture by
  // (repositoryCount, scenario) — the two selects — so every selection the
  // matrix offers must resolve to exactly one payload whose snapshot presents
  // the fixture's stage as current, which is the `{type:'state'}` the renderer
  // reads. This is the HOST half of the round trip; the render half is
  // executed in a VM in webview.test.ts.
  it('selects every matrix fixture by repository count and scenario', () => {
    const payloads = insidePreviewFixtures().map(previewPayloadFor);
    const bySelection = new Map(
      payloads.map((p) => [`${p.repositoryCount}:${p.scenario}`, p]),
    );
    expect(bySelection.size).toBe(payloads.length);
    for (const n of PREVIEW_REPO_COUNTS) {
      for (const s of PREVIEW_SCENARIOS) {
        const p = bySelection.get(`${n}:${s}`);
        expect(p, `missing payload for ${n} repos / ${s}`).toBeTruthy();
        // The snapshot the toolbar will dispatch as `{type:'state'}` presents
        // the fixture's stage as current — exactly what the renderer keys on.
        expect(p!.stage).toBe(p!.state.presentedStage);
        expect(p!.state.stageCurrent).toBe(p!.stage);
        expect(p!.state.key).toBe(`preview-${p!.id}`);
      }
    }
  });

  it('keeps the preview modules out of the production dashboard/state graph', () => {
    // Walk the reachable import graph from the production dashboard entry
    // points (state.ts and panel.ts) and assert neither the fixture matrix nor
    // the preview module is reachable — a production panel must never load the
    // fixture data (Finding 1's isolation constraint).
    const files = reachable([
      'src/ui/dashboard/state.ts',
      'src/ui/dashboard/panel.ts',
      'src/ui/dashboard/messages.ts',
      'src/ui/dashboard/webview.html',
    ]);
    expect(files.has('src/ui/dashboard/insideFixtures.ts')).toBe(false);
    expect(files.has('src/ui/dashboard/insidePreview.ts')).toBe(false);
  });
});

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+['"]([^'"]+)['"]/g;

function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    if (match[1]) continue; // `import type` is erased at runtime
    if (match[2]) found.push(match[2]);
  }
  return found;
}

/** Walk relative imports from the entry points; return every reachable file. */
function reachable(entries: readonly string[]): Set<string> {
  const files = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = relative(
        process.cwd(),
        resolve(dirname(file), specifier.replace(/\.js$/, '.ts')),
      );
      queue.push(target);
    }
  }
  return files;
}
