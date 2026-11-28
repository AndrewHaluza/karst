// @vitest-environment jsdom
/**
 * The header's Models button and its card (T1413). The customized-model chips left row 2: one icon button in
 * `.headerActions` carries every role whose identity differs from implementation (plus a graph ticket's Expert /
 * Worker / Fast). The card is the tooltip (`@ui:UI-R22`, `@ui:UI-R44`): hover (300 ms) or focus opens it, click
 * toggles, Escape closes, focus never leaves the button, and only one header surface is open at a time.
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { $, has, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';

installHeaderDoubles();

type Caps = Record<string, { provider: string; model: string | null } | null>;

const CAPS = (over: Caps = {}): Caps => ({
  implementation: { provider: 'claude', model: 'm1' },
  uatTester: null,
  review: null,
  graphExpert: null,
  graphWorker: null,
  graphFast: null,
  ...over,
});

const catalog = {
  claude: [
    { id: 'm1', label: 'Model One' },
    { id: 'm2', label: 'Model Two' },
    { id: 'm3', label: 'Model Three' },
    { id: 'm4', label: 'Model Four' },
    { id: 'm5', label: 'Model Five' },
  ],
  opencode: [{ id: 'go', label: 'OpenCode Go' }],
};

const withRoles = (caps: Caps, models: unknown = catalog) =>
  headerState({
    agentSwitch: { ...headerState().agentSwitch, modelsByCore: models },
    capabilityIdentity: caps,
  });

/** A graph ticket: Expert on Claude Code / Model Two, Worker and Fast on OpenCode / OpenCode Go — two groups. */
const graph = (): ReturnType<typeof headerState> =>
  withRoles(
    CAPS({
      graphExpert: { provider: 'claude', model: 'm2' },
      graphWorker: { provider: 'opencode', model: 'go' },
      graphFast: { provider: 'opencode', model: 'go' },
    }),
  );

const models = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('#modelsBtn');
const card = (): HTMLElement | null => document.querySelector<HTMLElement>('#modelsCard');

describe('ModelsButton — when it shows and what it names', () => {
  it('draws no button when every role uses the implementation model', () => {
    mountHeader(headerState());
    expect(models()).toBeNull();
    mountHeader(withRoles(CAPS({ uatTester: { provider: 'claude', model: 'm1' }, review: { provider: 'claude', model: 'm1' } })));
    expect(models()).toBeNull();
  });

  it('draws one icon per group and names every role, core and model in its aria-label', () => {
    mountHeader(graph());
    const btn = models()!;
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('k-iconbtn')).toBe(true);
    expect(btn.querySelectorAll('.modelsIcon')).toHaveLength(2);
    expect(btn.getAttribute('aria-label')).toBe('Models: Expert Claude Code Model Two; Worker · Fast OpenCode OpenCode Go');
    // The card is the tooltip: never a second surface on the button itself (@ui:RD-A11Y).
    expect(btn.hasAttribute('data-tip')).toBe(false);
    expect(btn.hasAttribute('title')).toBe(false);
  });

  it('collapses more than three groups to two icons and +N', () => {
    mountHeader(
      withRoles(
        CAPS({
          uatTester: { provider: 'claude', model: 'm2' },
          review: { provider: 'claude', model: 'm3' },
          graphExpert: { provider: 'opencode', model: 'go' },
          graphWorker: { provider: 'claude', model: 'm4' },
          graphFast: { provider: 'claude', model: 'm5' },
        }),
      ),
    );
    const btn = models()!;
    expect(btn.querySelectorAll('.modelsIcon')).toHaveLength(2);
    expect(btn.querySelector('.modelsMore')!.textContent).toBe('+3');
  });
});

describe('ModelsCard — the host facts', () => {
  it('opens on keyboard focus as a tooltip, linked by aria-describedby, with full labels and the implementation line', () => {
    mountHeader(graph());
    act(() => models()!.focus());
    const el = card();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('tooltip');
    expect(el!.getAttribute('id')).toBe('modelsCard');
    expect(models()!.getAttribute('aria-describedby')).toBe('modelsCard');
    expect(el!.querySelector('.modelsCardTitle')!.textContent).toBe('Models');
    const rows = [...el!.querySelectorAll('.modelsCardRow')].map((r) => r.textContent);
    expect(rows).toEqual(['ExpertClaude Code · Model Two', 'Worker · FastOpenCode · OpenCode Go']);
    expect(el!.querySelectorAll('.modelsCardRow .agenticon')).toHaveLength(2);
    // UI-R44: the card wraps the full label; it never ellipsises it.
    expect(el!.querySelector('.modelsCardOther')!.textContent).toBe('Other roles use the implementation model: Claude Code · Model One');
  });

  it('leaves the implementation line out when the host names no implementation identity', () => {
    mountHeader(withRoles(CAPS({ implementation: null, graphExpert: { provider: 'claude', model: 'm2' } })));
    act(() => models()!.focus());
    expect(card()!.querySelector('.modelsCardOther')).toBeNull();
  });

  it('closes on Escape and keeps focus on the button', () => {
    mountHeader(graph());
    act(() => models()!.focus());
    expect(card()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(models());
    expect(models()!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('toggles on click', () => {
    mountHeader(graph());
    fireEvent.click(models()!);
    expect(card()).not.toBeNull();
    fireEvent.click(models()!);
    expect(card()).toBeNull();
  });
});

describe('ModelsButton — one header surface at a time', () => {
  it('closes an open ⋯ menu when the card opens', () => {
    mountHeader(graph());
    fireEvent.click($('#moreBtn'));
    expect(has('#menuPopover', 'open')).toBe(true);
    act(() => models()!.focus());
    expect(card()).not.toBeNull();
    expect(has('#menuPopover', 'hidden')).toBe(true);
  });

  it('closes the open card when the ⋯ menu opens', () => {
    mountHeader(graph());
    act(() => models()!.focus());
    expect(card()).not.toBeNull();
    fireEvent.click($('#moreBtn'));
    expect(card()).toBeNull();
    expect(has('#menuPopover', 'open')).toBe(true);
  });
});
