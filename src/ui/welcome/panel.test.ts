import { describe, it, expect, vi } from 'vitest';
import { WelcomeManager, type WelcomePanel, type WelcomePanelHost } from './panel.js';
import type { WelcomeHostMessage } from './messages.js';
import type { WelcomeState } from './state.js';
import type { WelcomeActionsCtx } from './actions.js';

function fakeState(): WelcomeState {
  return { checklist: [], tutorial: [] };
}

class FakePanel implements WelcomePanel {
  revealed = 0;
  posted: WelcomeHostMessage[] = [];
  private msgHandler?: (m: unknown) => void;
  private disposeHandler?: () => void;
  reveal(): void {
    this.revealed += 1;
  }
  postMessage(m: WelcomeHostMessage): void {
    this.posted.push(m);
  }
  onDidReceiveMessage(h: (m: unknown) => void): void {
    this.msgHandler = h;
  }
  onDidDispose(h: () => void): void {
    this.disposeHandler = h;
  }
  send(m: unknown): void {
    this.msgHandler?.(m);
  }
  dispose(): void {
    this.disposeHandler?.();
  }
}

function makeHost() {
  const panels: FakePanel[] = [];
  const host: WelcomePanelHost = {
    createPanel: () => {
      const p = new FakePanel();
      panels.push(p);
      return p;
    },
  };
  return { host, panels };
}

describe('WelcomeManager', () => {
  it('pushes state on open', () => {
    const { host, panels } = makeHost();
    const mgr = new WelcomeManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.posted[0]).toEqual({ type: 'state', state: fakeState() });
  });

  it('reveals the existing panel instead of duplicating', () => {
    const { host, panels } = makeHost();
    const mgr = new WelcomeManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    mgr.open();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealed).toBe(1);
  });

  it('routes messages to actions and survives a bad message', () => {
    const { host, panels } = makeHost();
    const recheckDeps = vi.fn();
    const logError = vi.fn();
    const mgr = new WelcomeManager(
      fakeState,
      host,
      () => ({
        createManifest: vi.fn(),
        recheckDeps,
        openSettings: vi.fn(),
        createTicket: vi.fn(),
        dismiss: vi.fn(),
        requestState: vi.fn(),
      }),
      logError,
    );
    mgr.open();
    panels[0]!.send({ type: 'recheck-deps' });
    panels[0]!.send({ type: 'evil' }); // ignored, no throw
    expect(recheckDeps).toHaveBeenCalledOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it('recreates the panel after disposal', () => {
    const { host, panels } = makeHost();
    const mgr = new WelcomeManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    panels[0]!.dispose();
    expect(mgr.isOpen()).toBe(false);
    mgr.open();
    expect(panels).toHaveLength(2);
  });

  it('binds pushState so an action re-reads loadState', () => {
    const { host, panels } = makeHost();
    let capturedCtx: WelcomeActionsCtx | undefined;
    const loadState = vi.fn(fakeState);
    const mgr = new WelcomeManager(loadState, host, (ctx) => {
      capturedCtx = ctx;
      return {
        createManifest: vi.fn(),
        recheckDeps: () => ctx.pushState(),
        openSettings: vi.fn(),
        createTicket: vi.fn(),
        dismiss: vi.fn(),
        requestState: vi.fn(),
      };
    });
    mgr.open();
    expect(loadState).toHaveBeenCalledTimes(1); // initial push
    capturedCtx!.pushState();
    expect(loadState).toHaveBeenCalledTimes(2);
    expect(panels[0]!.posted).toHaveLength(2);
  });
});
