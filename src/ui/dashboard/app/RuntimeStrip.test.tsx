// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { DashboardSandboxView } from '../sandboxView.js';
import { $, headerState, installHeaderDoubles, mountRuntime } from './fixtures/headerKit.js';

installHeaderDoubles();

const SHELL_OK = { available: true, why: null };
const view = (over: Partial<DashboardSandboxView> = {}): DashboardSandboxView => ({
  backend: 'docker',
  core: 'claude',
  workspace: 'clone',
  network: 'allowlist proxy',
  actions: true,
  carry: false,
  shell: SHELL_OK,
  ...over,
});
const strip = (sandbox: DashboardSandboxView | null, over: Record<string, unknown> = {}) => mountRuntime(headerState({ sandbox, ...over }));
const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
const open = (sel: string): boolean => $(sel).classList.contains('open');
const sandboxBtn = (): HTMLElement => document.querySelectorAll<HTMLElement>('.rs-dd')[1]!;

describe('RuntimeStrip — layout', () => {
  it('renders nothing without an agent and without a sandbox', () => {
    mountRuntime(headerState({ agentSession: null, agentSwitch: null, sandbox: null }));
    expect(q('[data-testid="runtime-strip"]')).toBeNull();
  });

  it('shows the agent state word, the model and no effort when the session has none', () => {
    strip(view());
    expect($('#agentButton').textContent).toContain('Claude Code');
    expect($('#agentButton .rs-state').textContent).toBe('idle');
    expect($('#agentButton .rs-sub').textContent).toBe('Model One');
    expect($('#agentButton .rs-sub').getAttribute('title')).toBe('m1');
    expect($('#agentButton .rs-dot').getAttribute('aria-hidden')).toBe('true');
  });

  it('adds the effort and the running word when set', () => {
    strip(view(), { agentState: 'running', agentSession: { ...headerState().agentSession, effort: 'high' } });
    expect($('#agentButton .rs-state').textContent).toBe('running');
    expect($('#agentButton .rs-sub').textContent).toBe('Model One · high');
  });

  const ROUND = (roundActive: boolean) => ({ override: 'inherit' as const, projectDefault: true, effective: true, banner: null, log: [], roundActive });

  it('says "running · auto-fix" while an auto-fix round runs the agent', () => {
    strip(view(), { agentState: 'running', autopilot: ROUND(true) });
    expect($('#agentButton .rs-state').textContent).toBe('running · auto-fix');
    expect($('#agentButton .rs-state').className).toContain('running');
    expect($('#agentButton .rs-dot').className).toContain('running');
  });

  it('keeps the true state with the suffix when a round is active and no agent runs', () => {
    strip(view(), { agentState: 'idle', autopilot: ROUND(true) });
    expect($('#agentButton .rs-state').textContent).toBe('idle · auto-fix');
    expect($('#agentButton .rs-state').className).not.toContain('running');
    expect($('#agentButton .rs-dot').className).not.toContain('running');
  });

  it('adds no suffix when no round is active', () => {
    strip(view(), { agentState: 'running', autopilot: ROUND(false) });
    expect($('#agentButton .rs-state').textContent).toBe('running');
  });

  it('locks the agent dropdown during a fix recovery', () => {
    strip(view(), { agentSession: { ...headerState().agentSession, canSwitch: false } });
    expect(($('#agentButton') as HTMLButtonElement).disabled).toBe(true);
    expect($('#agentButton').getAttribute('title')).toBe('Cannot switch while a fix recovery is running');
    expect($('.rs-lock').textContent).toBe('fix recovery running');
    expect($('#agentButton [data-icon="lock"]')).toBeTruthy();
  });

  it('shows the docker backend with workspace and network in lower case', () => {
    strip(view());
    expect(sandboxBtn().textContent).toContain('Docker');
    expect(sandboxBtn().textContent).toContain('isolated git clone · allowlist proxy');
    expect(sandboxBtn().querySelector('[data-icon="box"]')).toBeTruthy();
  });

  it('shows host protection in the ok and warn tones', () => {
    strip(view({ backend: 'host', workspace: 'worktree', network: 'none (host)', hostProtection: 'core-native' }));
    expect(sandboxBtn().textContent).toContain('protected · worktree');
    expect(sandboxBtn().querySelector('.rs-sub--ok')).toBeTruthy();
    expect(sandboxBtn().querySelector('[data-icon="device-desktop"]')).toBeTruthy();
  });

  it('flags an unprotected host run', () => {
    strip(view({ backend: 'host', workspace: 'worktree', network: 'none (host)', hostProtection: 'prompted' }));
    expect(sandboxBtn().textContent).toContain('unprotected · worktree');
    expect(sandboxBtn().querySelector('.rs-sub--warn')).toBeTruthy();
  });

  it('hides the actions when the sandbox has none', () => {
    strip(view({ actions: false }));
    expect(q('[data-act="sandbox-sync"]')).toBeNull();
    expect(q('[aria-label="More sandbox actions"]')).toBeNull();
  });

  it('draws the carry note with its action, and the info note otherwise', () => {
    const h = strip(view({ carry: true }));
    expect($('.rs-note--warn').textContent).toContain('Host branch was rewritten — sync refused. Sandbox commits are safe.');
    fireEvent.click($('[data-act="sandbox-carry"]'));
    expect(h.send.sandboxCarry).toHaveBeenCalledTimes(1);
  });

  it('draws the fallback note', () => {
    strip(view({ backend: 'host', workspace: 'worktree', network: 'none (host)', note: 'Docker is not running' }));
    expect($('.rs-note--info').textContent).toContain('Docker is not running');
  });
});

describe('RuntimeStrip — popovers', () => {
  it('opens the sandbox details with the rows and the settings button', () => {
    const h = strip(view());
    expect(sandboxBtn().getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(sandboxBtn());
    expect(open('.rs-pop--sandbox')).toBe(true);
    expect(sandboxBtn().getAttribute('aria-expanded')).toBe('true');
    const text = $('.rs-pop--sandbox').textContent ?? '';
    for (const t of ['Workspace', 'Isolated git clone', 'Network', 'Allowlist proxy', 'Core', 'Claude Code', 'Backend is set per project']) expect(text).toContain(t);
    expect(text).not.toContain('Protection');
    fireEvent.click($('[data-act="open-settings"]'));
    expect(h.send.openSettings).toHaveBeenCalledTimes(1);
    expect(open('.rs-pop--sandbox')).toBe(false);
  });

  it('shows the protection row for a host run', () => {
    strip(view({ backend: 'host', workspace: 'worktree', network: 'none (host)', hostProtection: 'prompted' }));
    fireEvent.click(sandboxBtn());
    expect($('.rs-pop--sandbox').textContent).toContain('None — tool use is prompted');
  });

  it('keeps one popover open at a time', () => {
    strip(view());
    fireEvent.click($('#agentButton'));
    fireEvent.click(sandboxBtn());
    expect(open('#agentPopover')).toBe(false);
    expect(open('.rs-pop--sandbox')).toBe(true);
    fireEvent.click($('[aria-label="More sandbox actions"]'));
    expect(open('.rs-pop--sandbox')).toBe(false);
    expect(open('.rs-pop--menu')).toBe(true);
  });

  it('closes on an outside click and on Escape, returning focus to the trigger', () => {
    strip(view());
    fireEvent.click(sandboxBtn());
    fireEvent.click(document.body);
    expect(open('.rs-pop--sandbox')).toBe(false);
    fireEvent.click(sandboxBtn());
    fireEvent.keyDown($('.rs-pop--sandbox'), { key: 'Escape' });
    expect(open('.rs-pop--sandbox')).toBe(false);
    expect(document.activeElement).toBe(sandboxBtn());
  });
});

describe('RuntimeStrip — actions and menu', () => {
  it('posts Sync and Diff with the accessible names', () => {
    const h = strip(view());
    expect($('[data-act="sandbox-sync"]').getAttribute('aria-label')).toBe('Sync sandbox and host branches');
    expect($('[data-act="sandbox-diff"]').getAttribute('aria-label')).toBe('Show sandbox changes');
    fireEvent.click($('[data-act="sandbox-sync"]'));
    fireEvent.click($('[data-act="sandbox-diff"]'));
    expect(h.send.sandboxSync).toHaveBeenCalledTimes(1);
    expect(h.send.sandboxDiff).toHaveBeenCalledTimes(1);
  });

  it('orders the menu and posts each act at once, with no "…" in a label', () => {
    const h = strip(view());
    fireEvent.click($('[aria-label="More sandbox actions"]'));
    const items = Array.from(document.querySelectorAll<HTMLElement>('.rs-pop--menu [role="menuitem"]'));
    expect(items.map((i) => i.dataset.act)).toEqual(['sandbox-stash-update', 'sandbox-shell', 'sandbox-stop', 'sandbox-remove']);
    expect(items.map((i) => i.textContent).join('')).not.toContain('…');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.click(items[3]!);
    expect(h.send.sandboxRemove).toHaveBeenCalledTimes(1);
    expect(open('.rs-pop--menu')).toBe(false);
    expect(document.activeElement).toBe($('[aria-label="More sandbox actions"]'));
  });

  it('posts Open shell when it is available', () => {
    const h = strip(view());
    fireEvent.click($('[aria-label="More sandbox actions"]'));
    fireEvent.click($('[data-act="sandbox-shell"]'));
    expect(h.send.sandboxShell).toHaveBeenCalledTimes(1);
  });

  it('disables Open shell with the reason, and posts nothing', () => {
    const h = strip(view({ shell: { available: false, why: 'Sandbox is stopped' } }));
    fireEvent.click($('[aria-label="More sandbox actions"]'));
    const item = $('[data-act="sandbox-shell"]');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain('Sandbox is stopped');
    fireEvent.click(item);
    expect(h.send.sandboxShell).not.toHaveBeenCalled();
    expect(open('.rs-pop--menu')).toBe(true);
  });

  it('moves focus with the arrow, Home and End keys', () => {
    strip(view());
    fireEvent.click($('[aria-label="More sandbox actions"]'));
    const items = Array.from(document.querySelectorAll<HTMLElement>('.rs-pop--menu [role="menuitem"]'));
    const menu = $('.rs-pop--menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });
});
