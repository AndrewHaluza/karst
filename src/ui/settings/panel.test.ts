import { describe, it, expect } from 'vitest';
import { SettingsManager, type SettingsPanel, type LoadedManifest } from './panel.js';
import type { SettingsHostMessage } from './messages.js';
import type { Manifest } from '../../manifest/types.js';

const M: Manifest = {
  host: 'localhost', portRange: [4000, 4999], baselineBranch: 'develop',
  services: { api: { repoPath: '../api', start: 'x', ports: [{ name: 'port', env: 'PORT', default: 3000 }], dependsOn: [], hasMigrations: false, signals: [] } },
  approaches: [], agents: {}, worktreePathDisplay: 'relative',
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

function make(loaded: LoadedManifest, hasToken: () => Promise<boolean> = async () => false) {
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
    }),
    () => [],
    hasToken,
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
});
