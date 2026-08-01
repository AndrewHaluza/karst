import { describe, it, expect } from 'vitest';
import { SettingsManager, type SettingsPanel, type LoadedManifest } from './panel.js';
import type { SettingsHostMessage } from './messages.js';
import type { Manifest } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';
import {
  bundledModelCatalog,
  type ModelCatalog,
} from '../../agent/modelCatalog.js';

const M: Manifest = buildManifest(
  {
    api: runnableRepo(
      { start: 'x', ports: [slot('port', 'PORT', 3000)] },
      { repoPath: '../api', signals: [] },
    ),
  },
  { portRange: [4000, 4999], approaches: [], agents: {}, worktreePathDisplay: 'relative' },
);

const REMOTE_MODELS: ModelCatalog = {
  claude: [{ id: 'claude-remote', label: 'Claude Remote', providers: ['claude'] }],
  codex: [{ id: 'codex-remote', label: 'Codex Remote', providers: ['codex'] }],
  antigravity: [{ id: 'agy-remote', label: 'Antigravity Remote', providers: ['antigravity'] }],
};

class FakePanel implements SettingsPanel {
  posted: SettingsHostMessage[] = [];
  revealed = 0;
  handlers: Array<(m: unknown) => void> = [];
  disposeHandler?: () => void;
  reveal() { this.revealed++; }
  postMessage(m: SettingsHostMessage) { this.posted.push(m); }
  onDidReceiveMessage(h: (m: unknown) => void) { this.handlers.push(h); }
  onDidDispose(h: () => void) { this.disposeHandler = h; }
  emit(m: unknown) { this.handlers.forEach((h) => h(m)); }
}

function make(
  loaded: LoadedManifest,
  hasToken: () => Promise<boolean> = async () => false,
  modelCatalog: () => ModelCatalog = () => REMOTE_MODELS,
) {
  let panel!: FakePanel;
  const host = { createPanel: () => (panel = new FakePanel()) };
  const mgr = new SettingsManager(
    () => loaded,
    () => '/tmp/karst.yml',
    host,
    (ctx) => ({
      save: () => {},
      validate: () => {},
      installApproach: () => {},
      uninstallApproach: () => {},
      setToken: () => {},
      clearToken: () => {},
      setApproachEnabled: () => {},
      setAgentEnabled: () => {},
      saveAgentFile: () => {},
      createAgent: () => {},
      deleteAgent: () => {},
      requestState: () => ctx.post({ type: 'saved' }),
      getApproachCommandBody: () => {},
      fetchTicketStatuses: () => {},
      fetchTicketLists: () => {},
      browseRepoPath: () => {},
    }),
    () => [],
    hasToken,
    undefined,
    undefined,
    undefined,
    modelCatalog,
  );
  return { mgr, panel: () => panel };
}

describe('SettingsManager', () => {
  it('opens with a valid manifest and null error', async () => {
    const { mgr, panel } = make({ manifest: M, error: null });
    await mgr.open();
    const state = panel().posted.find((m) => m.type === 'state') as any;
    expect(state.state.manifest).toEqual(M);
    expect(state.state.error).toBeNull();
    expect(mgr.isOpen()).toBe(true);
  });

  it('opens on an INVALID manifest, surfacing the error', async () => {
    const { mgr, panel } = make({ manifest: M, error: 'portRange min exceeds max' });
    await mgr.open();
    const state = panel().posted.find((m) => m.type === 'state') as any;
    expect(state.state.error).toBe('portRange min exceeds max');
  });

  it('carries the real tokenConfigured flag on the initial push', async () => {
    const { mgr, panel } = make({ manifest: M, error: null }, async () => true);
    await mgr.open();
    const state = panel().posted.find((m) => m.type === 'state') as any;
    expect(state.state.tokenConfigured).toBe(true);
  });

  it('pushes the current host model catalog', async () => {
    const { mgr, panel } = make({ manifest: M, error: null });
    await mgr.open();
    const state = panel().posted.find((m) => m.type === 'state') as any;
    expect(state.state.models).toEqual(REMOTE_MODELS);
  });

  it('refreshes the live panel from the current catalog', async () => {
    let catalog = bundledModelCatalog();
    const { mgr, panel } = make({ manifest: M, error: null }, undefined, () => catalog);
    await mgr.open();
    panel().posted.length = 0;
    catalog = REMOTE_MODELS;

    await mgr.refreshModels();

    const refresh = panel().posted[0] as any;
    expect(refresh.type).toBe('models');
    expect(refresh.models).toEqual(REMOTE_MODELS);
    expect(refresh.modelCompatibility.codex.map((model: { id: string }) => model.id))
      .toContain('codex-remote');
    expect(refresh.modelCompatibility.codex.map((model: { id: string }) => model.id))
      .toContain('gpt-5.6-sol');
  });

  it('does not refresh a disposed panel', async () => {
    let catalog = bundledModelCatalog();
    const { mgr, panel } = make({ manifest: M, error: null }, undefined, () => catalog);
    await mgr.open();
    panel().disposeHandler?.();
    panel().posted.length = 0;
    catalog = REMOTE_MODELS;

    await mgr.refreshModels();

    expect(panel().posted).toEqual([]);
  });

  it('reveals instead of duplicating when already open', async () => {
    const { mgr, panel } = make({ manifest: M, error: null });
    await mgr.open();
    await mgr.open();
    expect(panel().revealed).toBe(1); // second open revealed the existing panel
  });

  it('routes incoming messages through injected actions without throwing on junk', async () => {
    const { mgr, panel } = make({ manifest: M, error: null });
    await mgr.open();
    expect(() => panel().emit({ type: 'bogus' })).not.toThrow();
    panel().emit({ type: 'request-state' });
    expect(panel().posted.some((m) => m.type === 'saved')).toBe(true);
  });

  // § docs/ui/DESIGN-SYSTEM.md §5.3, UI-R13 — the single dispatch seam.
  describe('action-result', () => {
    it('reports ok:true for a parsed request carrying a requestId', async () => {
      const { mgr, panel } = make({ manifest: M, error: null });
      await mgr.open();
      panel().emit({ type: 'request-state', requestId: 'r1' });
      const result = panel().posted.find((m) => m.type === 'action-result') as any;
      expect(result).toEqual({ type: 'action-result', requestId: 'r1', ok: true });
    });

    it('posts nothing for an unparsed message, even one carrying a requestId', async () => {
      const { mgr, panel } = make({ manifest: M, error: null });
      await mgr.open();
      panel().emit({ type: 'bogus', requestId: 'r2' });
      expect(panel().posted.some((m) => m.type === 'action-result')).toBe(false);
    });

    it('reports ok:false when the routed action rejects', async () => {
      let panel!: FakePanel;
      const host = { createPanel: () => (panel = new FakePanel()) };
      const mgr = new SettingsManager(
        () => ({ manifest: M, error: null }),
        () => '/tmp/karst.yml',
        host,
        () => ({
          save: () => {},
          validate: () => {},
          installApproach: () => {},
          uninstallApproach: () => {},
          setToken: () => {},
          clearToken: () => {},
          setApproachEnabled: () => {},
          setAgentEnabled: () => {},
          saveAgentFile: () => {},
          createAgent: () => {},
          deleteAgent: () => {},
          requestState: () => Promise.reject(new Error('boom')),
          getApproachCommandBody: () => {},
          fetchTicketStatuses: () => {},
          fetchTicketLists: () => {},
          browseRepoPath: () => {},
        }),
      );
      await mgr.open();
      panel.emit({ type: 'request-state', requestId: 'r3' });
      // The rejection is awaited asynchronously — flush microtasks.
      await Promise.resolve();
      await Promise.resolve();
      const result = panel.posted.find((m) => m.type === 'action-result') as any;
      expect(result).toEqual({ type: 'action-result', requestId: 'r3', ok: false, message: 'boom' });
    });
  });
});
