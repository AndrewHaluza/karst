// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createSender } from '../webviewSend.js';
import { App } from './App.js';
import { pageHostBridge } from './hostBridge.js';

describe('Dashboard App (Phase 1 Shell)', () => {
  beforeEach(() => {
    // The page's migrated-panel containers (webview.html): RegionPortal renders into these.
    document.body.innerHTML =
      '<div class="dhead"></div><div id="headerMeta" class="headerMeta" hidden></div>'
      + '<div class="railwrap" id="rail"></div><div id="inside"></div><div class="fault blocked hidden" id="blocked"></div>'
      + '<div class="panel span hidden" id="subtaskPanel"><div class="phead">Sub-tasks<span id="subtaskCount"></span></div><div id="subtasks"></div></div>'
      + '<div class="panel svpanel"><div class="phead">Servers<span id="srvCount"></span><span id="srvOps"></span></div><div id="servers"></div></div>'
      + '<div class="panel" id="worktreesPanel" data-react-owned="true"></div>'
      + '<div class="panel span prpanel"><div class="phead">Pull requests<span id="prCount"></span><span id="prOps"></span></div><div id="prs"></div></div>'
      + '<div class="panel span hidden" id="artPanel"><div class="phead">Artifacts</div><div id="artifacts"></div></div>'
      + '<div class="panel span hidden" id="storedPanel"><div class="phead">Captured artifacts</div><div id="storedSummary"></div></div>'
      + '<div id="ticketDataHost" class="tdHost"></div><div id="artView" class="artview hidden" tabindex="-1"></div>'
      + '<div id="termView" class="termview hidden" tabindex="-1"></div><div id="envView" class="envview hidden" tabindex="-1"></div>';
  });
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-karst-ready');
  });

  it('renders the dashboard app shell and sets data-karst-ready on mount', () => {
    const postMessage = vi.fn();
    (globalThis as unknown as { vscode: unknown }).vscode = {
      postMessage,
      getState: () => null,
      setState: vi.fn(),
    };

    expect(document.documentElement.hasAttribute('data-karst-ready')).toBe(false);

    render(<App bridge={pageHostBridge()} />);

    expect(document.documentElement.getAttribute('data-karst-ready')).toBe('true');
    expect(screen.getByTestId('dashboard-app-root')).toBeTruthy();
    expect(screen.getByTestId('dashboard-app-root').hasAttribute('data-react-owned')).toBe(true);
  });

  it('renders SandboxStrip when dashboard state has a sandbox view', () => {
    const bridge = {
      send: createSender({ postMessage: () => {} }),
      getState: () => ({
        state: {
          sandbox: {
            backend: 'sbx',
            core: 'claude',
            workspace: 'clone',
            network: 'sbx network policy (allowlist)',
            actions: true,
            carry: false,
          },
        },
      }),
      setState: vi.fn(),
      subscribe: () => () => {},
    };

    render(<App bridge={bridge} />);
    expect(screen.getByTestId('sandbox-strip')).toBeTruthy();
  });

  it('signals ready only once the DOM shows the first state the host pushed before the app subscribed', () => {
    const sandbox = { backend: 'sbx', core: 'claude', workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: false };
    const bridge = {
      send: createSender({ postMessage: () => {} }),
      getState: () => null,
      setState: vi.fn(),
      // The page's buffer replays what arrived before the first subscriber, inside the subscribe call.
      subscribe: (listener: (message: unknown) => void) => {
        listener({ type: 'state', state: { sandbox } });
        return () => {};
      },
    };
    const root = document.documentElement;
    const original = root.setAttribute.bind(root);
    const seenAtReady: boolean[] = [];
    root.setAttribute = (name: string, value: string): void => {
      if (name === 'data-karst-ready') seenAtReady.push(screen.queryByTestId('sandbox-strip') !== null);
      original(name, value);
    };
    try {
      render(<App bridge={bridge as never} />);
    } finally {
      root.setAttribute = original;
    }
    expect(seenAtReady).toEqual([true]);
  });

  it('signals ready once, and without a pushed state', () => {
    const root = document.documentElement;
    const original = root.setAttribute.bind(root);
    let calls = 0;
    root.setAttribute = (name: string, value: string): void => {
      if (name === 'data-karst-ready') calls += 1;
      original(name, value);
    };
    try {
      render(<App bridge={{ send: createSender({ postMessage: () => {} }), getState: () => null, setState: vi.fn(), subscribe: () => () => {} }} />);
    } finally {
      root.setAttribute = original;
    }
    expect(calls).toBe(1);
    expect(root.getAttribute('data-karst-ready')).toBe('true');
  });
});
