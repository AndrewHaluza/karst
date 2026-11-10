// @vitest-environment jsdom
/** The dashboard's runtime strip (arch:AC-32, AC-35): sandbox facts, labelled actions, the shell item and grid layout. */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebviewReady, type RenderHandle } from '../testing/renderHarness.js';
import { renderStateFor } from './renderFixtures.js';
import type { DashboardSandboxView } from './sandboxView.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const SBX: DashboardSandboxView = {
  backend: 'sbx', core: 'claude', workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: false, shell: { available: true, why: null },
};

async function open(sandbox: DashboardSandboxView | null): Promise<RenderHandle> {
  h = await renderWebviewReady('dashboard');
  h.receive({ type: 'state', state: { ...renderStateFor('impl'), sandbox } });
  await drainReactWork(h);
  return h;
}

const REGION = '[data-region="runtime"]';
const MORE = `${REGION} [aria-label="More sandbox actions"]`;

describe('dashboard runtime strip', () => {
  it('is always shown, with the agent and without a sandbox view', async () => {
    const v = await open(null);
    const strip = v.query(REGION)!;
    expect(strip.querySelector('#agentButton')).not.toBeNull();
    expect(strip.querySelector('[data-act="sandbox-sync"]')).toBeNull();
    expect(v.query('[data-region="sandbox"]')).toBeNull();
  });

  it('sits under the header and before the stepper and the grid', async () => {
    const v = await open(SBX);
    const strip = v.query(REGION)!;
    const follows = (sel: string): boolean => !!(strip.compareDocumentPosition(v.query(sel)!) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows('.stepper')).toBe(true);
    expect(follows('.grid')).toBe(true);
    expect(!!(v.query('.dhead')!.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('shows the backend, the workspace and the network, and opens the details with the core', async () => {
    const v = await open(SBX);
    const strip = v.query(REGION)!;
    expect(strip.textContent).toContain('sbx');
    expect(strip.textContent).toContain('isolated git clone · allowlist proxy');
    v.click(`${REGION} .rs-dd[aria-haspopup="dialog"]:not(#agentButton)`);
    expect(v.query('.rs-pop--sandbox')!.textContent).toContain('Claude Code');
  });

  it.each([
    ['sandbox-sync', 'Sync sandbox and host branches'],
    ['sandbox-diff', 'Show sandbox changes'],
  ])('%s is labelled, accessible, and posts its message', async (act, label) => {
    const v = await open(SBX);
    const btn = v.query<HTMLButtonElement>(`${REGION} [data-act="${act}"]`)!;
    expect(btn.getAttribute('aria-label')).toBe(label);
    expect(btn.getAttribute('title')).toBe(label);
    v.click(`${REGION} [data-act="${act}"]`);
    expect(v.posted).toContainEqual(expect.objectContaining({ type: act }));
  });

  it.each(['sandbox-stash-update', 'sandbox-shell', 'sandbox-stop', 'sandbox-remove'])('menu item %s posts at once', async (act) => {
    const v = await open(SBX);
    v.click(MORE);
    v.click(`${REGION} [data-act="${act}"]`);
    expect(v.posted.filter((m) => (m as { type?: string }).type === act)).toHaveLength(1);
  });

  it('one click posts exactly one message with a requestId, goes pending, and is not re-triggerable', async () => {
    const v = await open(SBX);
    const sel = `${REGION} [data-act="sandbox-sync"]`;
    v.click(sel);
    v.click(sel);
    const sent = v.posted.filter((m) => (m as { type?: string }).type === 'sandbox-sync');
    expect(sent).toHaveLength(1);
    expect(typeof (sent[0] as { requestId?: unknown }).requestId).toBe('string');
    const btn = v.query<HTMLButtonElement>(sel)!;
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    await v.receive({ type: 'action-result', requestId: (sent[0] as { requestId: string }).requestId, ok: true });
    expect(v.query<HTMLButtonElement>(sel)!.disabled).toBe(false);
  });

  it('offers "Carry commits onto host" only for a rewritten host branch', async () => {
    expect((await open(SBX)).query(`${REGION} [data-act="sandbox-carry"]`)).toBeNull();
    const v = await open({ ...SBX, carry: true });
    expect(v.query(`${REGION} [data-act="sandbox-carry"]`)!.textContent).toContain('Carry commits onto host');
    v.click(`${REGION} [data-act="sandbox-carry"]`);
    expect(v.posted).toContainEqual(expect.objectContaining({ type: 'sandbox-carry' }));
  });

  it('a host fallback explains why and offers no sandbox actions', async () => {
    const v = await open({ backend: 'host', core: 'antigravity', workspace: 'worktree', network: 'none (host)', actions: false, carry: false, shell: { available: false, why: 'No sandbox yet' }, note: 'antigravity: sbx backend unsupported' });
    const strip = v.query(REGION)!;
    expect(strip.textContent).toContain('antigravity: sbx backend unsupported');
    expect(strip.querySelector('[data-act="sandbox-sync"]')).toBeNull();
    expect(strip.querySelector('[aria-label="More sandbox actions"]')).toBeNull();
  });

  it('restores Servers and Worktrees sharing row 1 and Pull requests spanning row 2', async () => {
    const v = await open(SBX);
    const srv = v.query('.grid .svpanel')!;
    const nextPanel = srv.nextElementSibling!;
    expect(nextPanel.querySelector('.phead')?.textContent).toContain('Worktrees');
    const prPanel = v.queryAll('.grid .panel.span').find((p) => p.querySelector('.phead')?.textContent?.includes('Pull requests'))!;
    expect(prPanel).not.toBeNull();
    expect(prPanel.classList.contains('span')).toBe(true);
  });
});
