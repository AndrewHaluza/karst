// @vitest-environment jsdom
/** The dashboard's Sandbox card (arch:AC-32): visibility, content and the four actions. */
import { afterEach, describe, expect, it } from 'vitest';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';
import { renderStateFor } from './renderFixtures.js';
import type { DashboardSandboxView } from './sandboxView.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const SBX: DashboardSandboxView = {
  backend: 'sbx', core: 'claude', workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: false,
};

function open(sandbox: DashboardSandboxView | null): RenderHandle {
  h = renderWebview('dashboard');
  h.receive({ type: 'state', state: { ...renderStateFor('impl'), sandbox } });
  return h;
}

describe('dashboard sandbox card', () => {
  it('is hidden for a host project', () => {
    expect(open(null).query('#sandboxPanel')!.classList.contains('hidden')).toBe(true);
  });

  it('shows backend, core, workspace mode and network profile', () => {
    const v = open(SBX);
    expect(v.query('#sandboxPanel')!.classList.contains('hidden')).toBe(false);
    const text = v.query('#sandboxBody')!.textContent!;
    expect(text).toContain('sbx');
    expect(text).toContain('claude');
    expect(text).toContain('workspace: clone');
    expect(text).toContain('network: sbx network policy (allowlist)');
  });

  it.each([
    ['sandbox-sync', 'Sync sandbox commits into the worktree'],
    ['sandbox-diff', 'Show what a sync would bring in'],
    ['sandbox-stop', 'Stop the sandbox (kept for the next open)'],
    ['sandbox-remove', 'Remove the sandbox'],
  ])('%s is labelled and posts its message', (act, label) => {
    const v = open(SBX);
    const btn = v.query<HTMLButtonElement>(`#sandboxOps [data-act="${act}"]`)!;
    expect(btn.getAttribute('aria-label')).toBe(label);
    expect(btn.getAttribute('title')).toBe(label);
    v.click(`#sandboxOps [data-act="${act}"]`);
    expect(v.posted).toContainEqual(expect.objectContaining({ type: act }));
  });

  it('offers "Carry sandbox commits onto host branch" only for a rewritten host branch', () => {
    expect(open(SBX).query('#sandboxOps [data-act="sandbox-carry"]')).toBeNull();
    const v = open({ ...SBX, carry: true });
    const btn = v.query<HTMLButtonElement>('#sandboxOps [data-act="sandbox-carry"]')!;
    expect(btn.getAttribute('aria-label')).toBe('Carry sandbox commits onto host branch');
    v.click('#sandboxOps [data-act="sandbox-carry"]');
    expect(v.posted).toContainEqual(expect.objectContaining({ type: 'sandbox-carry' }));
  });

  it('a host fallback explains why and offers no actions', () => {
    const v = open({ backend: 'host', core: 'antigravity', workspace: 'worktree', network: 'none (host)', actions: false, carry: false, note: 'antigravity: sbx backend unsupported' });
    expect(v.query('#sandboxBody')!.textContent).toContain('antigravity: sbx backend unsupported — runs prompted on the host.');
    expect(v.query('#sandboxOps')!.children).toHaveLength(0);
  });
});
