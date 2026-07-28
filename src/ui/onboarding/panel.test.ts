import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { OnboardingManager } from './panel.js';
import type { OnboardingPanel, OnboardingPanelHost, OnboardingActionsCtx } from './panel.js';
import type { OnboardingActions } from './messages.js';
import type { Manifest, RepositoryDef } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';
import {
  bundledModelCatalog,
  type ModelCatalog,
} from '../../agent/modelCatalog.js';

function svc(over: Partial<RepositoryDef> = {}): RepositoryDef {
  return runnableRepo({ start: 'x', ports: [slot('port', 'PORT', 3000)] }, over);
}

const MANIFEST: Manifest = buildManifest(
  { fe: svc({ signals: ['ui'] }) },
  {
    portRange: [4000, 4100],
    approaches: [{ id: 'rpi', label: 'RPI', recommended: true }],
    agents: {},
    worktreePathDisplay: 'absolute',
  },
);

const REMOTE_MODELS: ModelCatalog = {
  claude: [{ id: 'claude-remote', label: 'Claude Remote', providers: ['claude'] }],
  codex: [{ id: 'codex-remote', label: 'Codex Remote', providers: ['codex'] }],
  antigravity: [{ id: 'agy-remote', label: 'Antigravity Remote', providers: ['antigravity'] }],
};

interface FakePanel extends OnboardingPanel {
  title: string;
  revealed: number;
  posted: unknown[];
  icons: string[];
  handlers: Array<(m: unknown) => void>;
  disposeHandler?: () => void;
  emit(m: unknown): void;
  dispose(): void;
}

function fakeHost(): { host: OnboardingPanelHost; panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  const host: OnboardingPanelHost = {
    createPanel(title: string): OnboardingPanel {
      const panel: FakePanel = {
        title,
        revealed: 0,
        posted: [],
        icons: [],
        handlers: [],
        reveal: () => (panel.revealed += 1),
        setIcon: (p) => panel.icons.push(p),
        postMessage: (m) => panel.posted.push(m),
        onDidReceiveMessage: (h) => panel.handlers.push(h),
        onDidDispose: (h) => (panel.disposeHandler = h),
        emit: (m) => panel.handlers.forEach((h) => h(m)),
        dispose: () => panel.disposeHandler?.(),
      };
      panels.push(panel);
      return panel;
    },
  };
  return { host, panels };
}

/** A no-op actions factory that records the ctx it was built with. */
function recordingFactory(seen: OnboardingActionsCtx[] = []) {
  const factory = (ctx: OnboardingActionsCtx): OnboardingActions => {
    seen.push(ctx);
    return {
      fetchSource: () => {},
      suggestSignals: () => {},
      saveSignals: () => {},
      setRepos: () => {},
      setApproach: () => {},
      setAgent: () => {},
      setModel: () => {},
      setProvider: () => {},
      setType: () => {},
      analyze: () => {},
      openTicketLink: () => {},
      submit: () => {},
      save: () => {},
      requestState: () => ctx.pushState(),
    };
  };
  return { factory, seen };
}

describe('OnboardingManager', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('opens a create-mode panel and pushes initial state', () => {
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    expect(panels).toHaveLength(1);
    const first = panels[0]!.posted[0] as { type: string; state: { mode: string } };
    expect(first.type).toBe('state');
    expect(first.state.mode).toBe('create');
  });

  it('pushes models from the current host catalog', () => {
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(
      store,
      () => ({ ...MANIFEST, agentProvider: 'codex' }),
      host,
      factory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => REMOTE_MODELS,
    );

    mgr.openCreate();
    const first = panels[0]!.posted[0] as { state: { models: unknown[] } };
    expect(first.state.models).toEqual(REMOTE_MODELS.codex);
  });

  it('refreshes every live panel from the current catalog and skips disposed panels', () => {
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    let catalog = bundledModelCatalog();
    const mgr = new OnboardingManager(
      store,
      () => MANIFEST,
      host,
      factory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => catalog,
    );

    mgr.openCreate();
    mgr.openCreate();
    mgr.openCreate();
    panels[1]!.dispose();
    for (const panel of panels) panel.posted.length = 0;
    catalog = REMOTE_MODELS;

    mgr.refreshModels();

    expect((panels[0]!.posted[0] as { state: { models: unknown[] } }).state.models)
      .toEqual(REMOTE_MODELS.claude);
    expect(panels[1]!.posted).toEqual([]);
    expect((panels[2]!.posted[0] as { state: { models: unknown[] } }).state.models)
      .toEqual(REMOTE_MODELS.claude);
  });

  it('opens an edit-mode panel seeded from the ticket', () => {
    const t = createTicket(store, { key: 'P-1', title: 'thing' });
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openEdit(t.id);
    const first = panels[0]!.posted[0] as { state: { mode: string; key: string } };
    expect(first.state.mode).toBe('edit');
    expect(first.state.key).toBe('P-1');
  });

  it('tints the edit-panel tab icon from iconFor on open and on each push', () => {
    const t = createTicket(store, { key: 'P-1', title: 'thing' });
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(
      store,
      () => MANIFEST,
      host,
      factory,
      undefined,
      undefined,
      undefined,
      undefined,
      () => '/store/icons/karst-gray.svg',
    );

    mgr.openEdit(t.id);
    expect(panels[0]!.icons).toContain('/store/icons/karst-gray.svg');
  });

  it('titles the edit panel with the ticket key and title, not the SQL id', () => {
    const t = createTicket(store, { key: 'CU-1234', title: 'Add PDF export' });
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openEdit(t.id);
    // Human label (`key — title`), never `#<sqlId>`.
    expect(panels[0]!.title).toBe('CU-1234 — Add PDF export');
    expect(panels[0]!.title).not.toContain(`#${t.id}`);
  });

  it('reuses the edit panel for the same ticket instead of duplicating', () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openEdit(t.id);
    mgr.openEdit(t.id);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealed).toBeGreaterThan(0);
  });

  it('routes a request-state message back through the ctx pushState', () => {
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    panels[0]!.posted.length = 0; // clear initial push
    panels[0]!.emit({ type: 'request-state' });
    const pushed = panels[0]!.posted.at(-1) as { type: string };
    expect(pushed.type).toBe('state');
  });

  it('rebinds a create panel to a ticket so the next pushState is edit mode', () => {
    const t = createTicket(store, { key: 'P-9', title: 'bound' });
    const { host, panels } = fakeHost();
    const { factory, seen } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    const ctx = seen[0]!;
    expect(ctx.ticketId).toBeUndefined();
    ctx.bindTicket(t.id);
    expect(ctx.ticketId).toBe(t.id);

    panels[0]!.posted.length = 0;
    ctx.pushState();
    const pushed = panels[0]!.posted.at(-1) as {
      state: { mode: string; ticketId?: number; key: string };
    };
    expect(pushed.state.mode).toBe('edit');
    expect(pushed.state.ticketId).toBe(t.id);
    expect(pushed.state.key).toBe('P-9');
  });

  it('ctx.close disposes the panel and frees its key for a later open', () => {
    const { host, panels } = fakeHost();
    const { factory, seen } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    expect(mgr.isCreateOpen()).toBe(true);
    seen[0]!.close();
    // Disposing is what closes the tab; the dispose handler unregisters the key.
    expect(mgr.isCreateOpen()).toBe(false);
    mgr.openCreate();
    expect(panels).toHaveLength(2);
  });

  it('ctx.close is idempotent and never posts to a disposed panel', () => {
    const { host, panels } = fakeHost();
    const { factory, seen } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    const ctx = seen[0]!;
    ctx.close();
    panels[0]!.posted.length = 0;
    expect(() => ctx.close()).not.toThrow();
    ctx.pushState(); // a late action must not talk to a dead panel
    expect(panels[0]!.posted).toEqual([]);
  });

  it('opens a fresh create panel every time instead of revealing the open one', () => {
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    mgr.openCreate();
    expect(panels).toHaveLength(2);
    expect(panels[0]!.revealed).toBe(0);
    const second = panels[1]!.posted[0] as { state: { mode: string } };
    expect(second.state.mode).toBe('create');
  });

  it('opens a fresh create panel even after the open one bound a draft ticket', () => {
    const t = createTicket(store, { key: 'P-5', title: 'draft' });
    const { host, panels } = fakeHost();
    const { factory, seen } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    seen[0]!.bindTicket(t.id);
    mgr.openCreate();

    expect(panels).toHaveLength(2);
    const second = panels[1]!.posted[0] as { state: { mode: string } };
    expect(second.state.mode).toBe('create');
  });

  it('rekeys a bound create panel so openEdit reveals it instead of duplicating', () => {
    const t = createTicket(store, { key: 'P-7', title: 'bound' });
    const { host, panels } = fakeHost();
    const { factory, seen } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    seen[0]!.bindTicket(t.id);
    mgr.openEdit(t.id);

    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealed).toBe(1);
  });

  it('drops a panel on dispose so a later open recreates it', () => {
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new OnboardingManager(store, () => MANIFEST, host, factory);

    mgr.openCreate();
    panels[0]!.dispose();
    mgr.openCreate();
    expect(panels).toHaveLength(2);
  });
});
