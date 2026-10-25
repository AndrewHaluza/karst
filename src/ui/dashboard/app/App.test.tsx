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
      '<div class="panel span hidden" id="subtaskPanel"><div class="phead">Sub-tasks<span id="subtaskCount"></span></div><div id="subtasks"></div></div>'
      + '<div class="panel svpanel"><div class="phead">Servers<span id="srvCount"></span><span id="srvOps"></span></div><div id="servers"></div></div>'
      + '<div class="panel" id="worktreesPanel" data-react-owned="true"></div>'
      + '<div class="panel span prpanel"><div class="phead">Pull requests<span id="prCount"></span><span id="prOps"></span></div><div id="prs"></div></div>';
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
});
