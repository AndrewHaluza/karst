// @vitest-environment jsdom
/** The dashboard's Sandbox full-width strip (V1, arch:AC-32): visibility, content, labelled actions and grid layout. */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebviewReady, type RenderHandle } from '../testing/renderHarness.js';
import { renderStateFor } from './renderFixtures.js';
import type { DashboardSandboxView } from './sandboxView.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const SBX: DashboardSandboxView = {
  backend: 'sbx', core: 'claude', workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: false,
};

async function open(sandbox: DashboardSandboxView | null): Promise<RenderHandle> {
  h = await renderWebviewReady('dashboard');
  h.receive({ type: 'state', state: { ...renderStateFor('impl'), sandbox } });
  await drainReactWork(h);
  return h;
}

describe('dashboard sandbox strip (V1)', () => {
  it('is absent for a host project and removed from grid', async () => {
    const v = await open(null);
    expect(v.query('[data-region="sandbox"]')).toBeNull();
    expect(v.query('#sandboxPanel')).toBeNull();
  });

  it('renders above the grid and shows backend, canonical core, workspace mode and network profile', async () => {
    const v = await open(SBX);
    const strip = v.query('[data-region="sandbox"]')!;
    expect(strip).not.toBeNull();

    // Sits inside #root which precedes .grid
    const root = v.query('#root')!;
    const grid = v.query('.grid')!;
    expect(root.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const text = strip.textContent!;
    expect(text).toContain('Sandbox');
    expect(text).toContain('sbx');
    expect(text).toContain('Claude Code');
    expect(text).toContain('Isolated Git Clone');
    expect(text).toContain('Allowlist Proxy');
  });

  it.each([
    ['sandbox-sync', 'Sync sandbox commits into the worktree', 'Sync'],
    ['sandbox-diff', 'Show what a sync would bring in', 'Diff'],
    ['sandbox-stop', 'Stop the sandbox (kept for the next open)', 'Stop'],
    ['sandbox-remove', 'Remove the sandbox', 'Remove…'],
  ])('%s is labelled, accessible, and posts its message', async (act, label, visibleText) => {
    const v = await open(SBX);
    const btn = v.query<HTMLButtonElement>(`[data-region="sandbox"] [data-act="${act}"]`)!;
    expect(btn.getAttribute('aria-label')).toBe(label);
    expect(btn.getAttribute('title')).toBe(label);
    expect(btn.textContent).toContain(visibleText);
    if (act === 'sandbox-remove') {
      expect(btn.classList.contains('k-btn--danger')).toBe(true);
    }
    v.click(`[data-region="sandbox"] [data-act="${act}"]`);
    expect(v.posted).toContainEqual(expect.objectContaining({ type: act }));
  });

  it('one click posts exactly one message with a requestId, goes pending, and is not re-triggerable', async () => {
    const v = await open(SBX);
    const sel = '[data-region="sandbox"] [data-act="sandbox-sync"]';
    v.click(sel);
    v.click(sel);
    const sent = v.posted.filter((m) => (m as { type?: string }).type === 'sandbox-sync');
    expect(sent).toHaveLength(1);
    expect(typeof (sent[0] as { requestId?: unknown }).requestId).toBe('string');
    const btn = v.query<HTMLButtonElement>(sel)!;
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    // The host's ack settles it and the control is usable again.
    await v.receive({ type: 'action-result', requestId: (sent[0] as { requestId: string }).requestId, ok: true });
    expect(v.query<HTMLButtonElement>(sel)!.disabled).toBe(false);
  });

  it('offers "Carry to host" only for a rewritten host branch', async () => {
    expect((await open(SBX)).query('[data-region="sandbox"] [data-act="sandbox-carry"]')).toBeNull();
    const v = await open({ ...SBX, carry: true });
    const btn = v.query<HTMLButtonElement>('[data-region="sandbox"] [data-act="sandbox-carry"]')!;
    expect(btn.getAttribute('aria-label')).toBe('Carry sandbox commits onto host branch');
    expect(btn.textContent).toContain('Carry to host');
    v.click('[data-region="sandbox"] [data-act="sandbox-carry"]');
    expect(v.posted).toContainEqual(expect.objectContaining({ type: 'sandbox-carry' }));
  });

  it('a host fallback explains why and offers no actions', async () => {
    const v = await open({ backend: 'host', core: 'antigravity', workspace: 'worktree', network: 'none (host)', actions: false, carry: false, note: 'antigravity: sbx backend unsupported' });
    const strip = v.query('[data-region="sandbox"]')!;
    expect(strip.textContent).toContain('antigravity: sbx backend unsupported — runs prompted on the host.');
    expect(strip.querySelectorAll('button')).toHaveLength(0);
  });

  it('restores Servers and Worktrees sharing row 1 and Pull requests spanning row 2', async () => {
    const v = await open(SBX);
    // In .grid, the panel following .svpanel (Servers) is Worktrees
    const srv = v.query('.grid .svpanel')!;
    const nextPanel = srv.nextElementSibling!;
    expect(nextPanel.querySelector('.phead')?.textContent).toContain('Worktrees');
    // Pull requests spans row 2
    const prPanel = v.queryAll('.grid .panel.span').find((p) => p.querySelector('.phead')?.textContent?.includes('Pull requests'))!;
    expect(prPanel).not.toBeNull();
    expect(prPanel.classList.contains('span')).toBe(true);
  });
});
