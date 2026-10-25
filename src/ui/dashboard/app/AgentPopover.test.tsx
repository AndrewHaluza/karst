// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { $, has, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';

installHeaderDoubles();

type Opts = { value: { core: string; model: string; effort: string }; onChange: (v: { core: string; model: string; effort: string }) => void } & Record<string, unknown>;

/** A picker double: records every mount and exposes the options the page last handed it. */
function installPicker() {
  const mounts: Array<{ root: HTMLElement; opts: Opts }> = [];
  (globalThis as unknown as { mountAgentPicker: unknown }).mountAgentPicker = (root: HTMLElement, opts: Opts) => void mounts.push({ root, opts });
  return mounts;
}

describe('AgentPopover — the staged switch', () => {
  it('mounts the shared picker into the empty container on each open, staged from the current session', () => {
    const mounts = installPicker();
    mountHeader(headerState());
    expect(mounts).toHaveLength(0);
    fireEvent.click($('#agentButton'));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.root).toBe($('#agentSwitchPicker'));
    expect(mounts[0]!.opts.value).toEqual({ core: 'claude', model: 'm1', effort: '' });
    expect(mounts[0]!.opts.inheritCore).toBe('claude');
    expect(mounts[0]!.opts.inherit).toEqual({ core: 'Inherit (settings: claude)', model: 'Inherit (settings: M)', effort: 'E' });
    fireEvent.click($('#agentButton'));
    fireEvent.click($('#agentButton'));
    expect(mounts).toHaveLength(2);
  });

  it('hands the picker the route identity map the picker blob emits, or none when it is absent', () => {
    const mounts = installPicker();
    const scope = globalThis as unknown as Record<string, unknown>;
    delete scope.AP_ROUTES;
    mountHeader(headerState());
    fireEvent.click($('#agentButton'));
    expect(mounts[0]!.opts.routes).toEqual({});
    fireEvent.click($('#agentButton'));
    const routes = { openrouter: { name: 'OpenRouter' } };
    scope.AP_ROUTES = routes;
    fireEvent.click($('#agentButton'));
    expect(mounts[1]!.opts.routes).toBe(routes);
    delete scope.AP_ROUTES;
  });

  it('keeps Switch agent disabled until the draft differs, then posts the draft once and closes', () => {
    const mounts = installPicker();
    const h = mountHeader(headerState());
    fireEvent.click($('#agentButton'));
    expect(($('#switchBtn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click($('#switchBtn'));
    expect(h.send.switchAgent).not.toHaveBeenCalled();

    const { onChange } = mounts[0]!.opts;
    fireEvent.click($('#agentPopover .fieldHelp')); // an inside click keeps the popover open
    act(() => onChange({ core: 'claude', model: 'm2', effort: '' }));
    expect(($('#switchBtn') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click($('#switchBtn'));
    expect(h.send.switchAgent).toHaveBeenCalledTimes(1);
    expect(h.send.switchAgent).toHaveBeenCalledWith('claude', 'm2', null);
    expect(has('#agentPopover', 'hidden')).toBe(true);
  });

  it('posts nothing when the popover is closed without switching', () => {
    installPicker();
    const h = mountHeader(headerState());
    fireEvent.click($('#agentButton'));
    fireEvent.click($('#title'));
    expect(h.send.switchAgent).not.toHaveBeenCalled();
  });

  it('still renders the form when the picker runtime is absent', () => {
    mountHeader(headerState());
    fireEvent.click($('#agentButton'));
    expect($('#agentPopover .fieldHelp').textContent).toMatch(/Closing this menu takes no action/);
    expect(($('#switchBtn') as HTMLButtonElement).disabled).toBe(true);
  });
});
