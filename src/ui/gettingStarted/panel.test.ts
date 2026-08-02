import { describe, it, expect, vi } from 'vitest';
import { GettingStartedManager, type GettingStartedPanel, type GettingStartedPanelHost } from './panel.js';
import type { GettingStartedHostMessage } from './messages.js';
import type { GettingStartedState } from './state.js';
import type { GettingStartedActionsCtx } from './actions.js';

function fakeState(): GettingStartedState {
  return { checklist: [], tutorial: [] };
}

class FakePanel implements GettingStartedPanel {
  revealed = 0;
  posted: GettingStartedHostMessage[] = [];
  private msgHandler?: (m: unknown) => void;
  private disposeHandler?: () => void;
  reveal(): void {
    this.revealed += 1;
  }
  postMessage(m: GettingStartedHostMessage): void {
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
  const host: GettingStartedPanelHost = {
    createPanel: () => {
      const p = new FakePanel();
      panels.push(p);
      return p;
    },
  };
  return { host, panels };
}

describe('GettingStartedManager', () => {
  it('pushes state on open', () => {
    const { host, panels } = makeHost();
    const mgr = new GettingStartedManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.posted[0]).toEqual({ type: 'state', state: fakeState() });
  });

  it('reveals the existing panel instead of duplicating', () => {
    const { host, panels } = makeHost();
    const mgr = new GettingStartedManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
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
    const mgr = new GettingStartedManager(
      fakeState,
      host,
      () => ({
        createManifest: vi.fn(),
        recheckDeps,
        openSettings: vi.fn(),
        createTicket: vi.fn(),
        reportIssue: vi.fn(),
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
    const mgr = new GettingStartedManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    panels[0]!.dispose();
    expect(mgr.isOpen()).toBe(false);
    mgr.open();
    expect(panels).toHaveLength(2);
  });

  it('posts exactly one action-result per parsed request that carries a requestId (UI-R13)', async () => {
    const { host, panels } = makeHost();
    const mgr = new GettingStartedManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    panels[0]!.send({ type: 'recheck-deps', requestId: 'r1' });
    await Promise.resolve();
    await Promise.resolve();
    const results = panels[0]!.posted.filter((m) => m.type === 'action-result');
    expect(results).toEqual([{ type: 'action-result', requestId: 'r1', ok: true }]);
  });

  it('posts no action-result for a message with no requestId (back-compat)', async () => {
    const { host, panels } = makeHost();
    const recheckDeps = vi.fn();
    const mgr = new GettingStartedManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps,
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    panels[0]!.send({ type: 'recheck-deps' });
    await Promise.resolve();
    await Promise.resolve();
    expect(recheckDeps).toHaveBeenCalledOnce();
    expect(panels[0]!.posted.some((m) => m.type === 'action-result')).toBe(false);
  });

  it('reports a rejected action as ok:false with its message, and logs it', async () => {
    const { host, panels } = makeHost();
    const logError = vi.fn();
    const mgr = new GettingStartedManager(
      fakeState,
      host,
      () => ({
        createManifest: vi.fn().mockRejectedValue(new Error('disk full')),
        recheckDeps: vi.fn(),
        openSettings: vi.fn(),
        createTicket: vi.fn(),
        reportIssue: vi.fn(),
        dismiss: vi.fn(),
        requestState: vi.fn(),
      }),
      logError,
    );
    mgr.open();
    panels[0]!.send({ type: 'create-manifest', requestId: 'r2' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const results = panels[0]!.posted.filter((m) => m.type === 'action-result');
    expect(results).toEqual([{ type: 'action-result', requestId: 'r2', ok: false, message: 'disk full' }]);
    expect(logError).toHaveBeenCalledWith('karst: getting-started action failed', expect.any(Error));
  });

  it('acks a void action synchronously without waiting on anything (handoff kind)', async () => {
    const { host, panels } = makeHost();
    const mgr = new GettingStartedManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    panels[0]!.send({ type: 'open-settings', requestId: 'r3' });
    await Promise.resolve();
    await Promise.resolve();
    expect(panels[0]!.posted).toContainEqual({ type: 'action-result', requestId: 'r3', ok: true });
  });

  it('binds pushState so an action re-reads loadState', () => {
    const { host, panels } = makeHost();
    let capturedCtx: GettingStartedActionsCtx | undefined;
    const loadState = vi.fn(fakeState);
    const mgr = new GettingStartedManager(loadState, host, (ctx) => {
      capturedCtx = ctx;
      return {
        createManifest: vi.fn(),
        recheckDeps: () => ctx.pushState(),
        openSettings: vi.fn(),
        createTicket: vi.fn(),
        reportIssue: vi.fn(),
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
