// @vitest-environment jsdom
/**
 * The "create in <provider>" control derives its name and mark from the shared
 * provider identity (providerIdentity.ts), never from a literal (ui:UI-R31).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';

function baseState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'create', provider: 'manual', title: '', key: '', description: '',
    repos: [], approaches: [], agents: [], unclassified: [], attachments: [],
    ...over,
  };
}

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

function open(state: Record<string, unknown>): RenderHandle {
  h = renderWebview('ticketForm');
  h.receive({ type: 'state', state });
  return h;
}

describe('ticket form — create-in control derives from provider identity', () => {
  it('clickup create mode: switch label carries the name and the badge mark; title names the provider', () => {
    const v = open(baseState({ provider: 'clickup', canCreateProviderTicket: true }));
    const sw = v.query<HTMLElement>('#createIn')!;
    expect(v.query('#createInRow')!.classList.contains('hidden')).toBe(false);
    expect(sw.textContent).toContain('Also create in');
    expect(sw.querySelector('.provbadge .provname')!.textContent).toBe('ClickUp');
    expect(sw.querySelector('.provbadge .provicon svg')).toBeTruthy();
    expect(sw.getAttribute('title')).toContain('ClickUp');
  });

  it('clickup edit mode: button carries the badge and a titled provider name', () => {
    const v = open(baseState({ provider: 'clickup', mode: 'edit', canCreateProviderTicket: true, ticketId: 1 }));
    const btn = v.query<HTMLElement>('#createInBtn')!;
    expect(btn.classList.contains('hidden')).toBe(false);
    expect(btn.textContent).toContain('Create in');
    expect(btn.querySelector('.provname')!.textContent).toBe('ClickUp');
    expect(btn.getAttribute('title')).toContain('ClickUp');
  });

  it('manual: no switch, no create button, no badge anywhere in the control', () => {
    const v = open(baseState({ provider: 'manual', canCreateProviderTicket: false }));
    expect(v.query('#createInRow')!.classList.contains('hidden')).toBe(true);
    expect(v.query('#createInBtn')!.classList.contains('hidden')).toBe(true);
    expect(v.query('#createInRow .provbadge')).toBeNull();
    expect(v.query('#createInBtn .provbadge')).toBeNull();
    expect(v.query('#createInRow')!.textContent).not.toContain('ClickUp');
  });

  it('a provider with no mark degrades to its title-cased id and no icon', () => {
    const v = open(baseState({ provider: 'linear', canCreateProviderTicket: true }));
    const sw = v.query<HTMLElement>('#createIn')!;
    expect(sw.querySelector('.provname')!.textContent).toBe('Linear');
    expect(sw.querySelector('.provicon')).toBeNull();
    expect(sw.getAttribute('title')).toContain('Linear');
  });

  it('gating unchanged: no canCreateProviderTicket hides the control even for clickup', () => {
    const v = open(baseState({ provider: 'clickup', canCreateProviderTicket: false }));
    expect(v.query('#createInRow')!.classList.contains('hidden')).toBe(true);
  });

  it('the webview source has no literal ClickUp (identity is injected)', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ui/ticketForm/webview.html'), 'utf8');
    expect(src).not.toMatch(/ClickUp/);
  });
});
