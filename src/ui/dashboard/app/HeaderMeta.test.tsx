// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { $, headerState, installHeaderDoubles, mountHeader, originView } from './fixtures/headerKit.js';
import { ticketRefView } from '../../shared/ticketRefView.js';

installHeaderDoubles();

const caps = (over: Record<string, unknown>) => ({ implementation: { provider: 'claude', model: 'm1' }, uatTester: null, review: null, ...over });
const row = (): HTMLElement => $('#headerMeta');

describe('HeaderMeta — relations', () => {
  it('is hidden with no relation and no differing capability', () => {
    mountHeader(headerState());
    expect(row().hidden).toBe(true);
    expect($('#parentRef').hidden).toBe(true);
  });

  it('joins sub-task and follow-up relations with a dot, in one text run, and never the planning origin', () => {
    mountHeader(headerState({ origin: originView(), subtaskParent: { key: 'A', ref: 'T1 · A', title: null }, parent: { key: 'B', ref: 'T2 · B', title: null } }));
    expect(row().hidden).toBe(false);
    expect($('#parentRef').textContent).toBe('Sub-task of T1 · A · Follow-up of T2 · B');
    expect($('#parentRef').textContent).not.toContain('from D');
    expect($('#parentRef').childNodes).toHaveLength(1);
  });

  it('hides row 2 when the planning origin is the only fact it has — the P28 link lives in row 1', () => {
    mountHeader(headerState({ origin: originView() }));
    expect(row().hidden).toBe(true);
    expect($('#parentRef').hidden).toBe(true);
  });

  it('draws blockers as chips, linking only those with a ticket, and posts the dependency once', () => {
    const h = mountHeader(
      headerState({ blockers: [{ ticketId: 42, idLabel: 'T42', label: 'CU-1' }, { ticketId: null, idLabel: null, label: 'external' }] }),
    );
    expect($('#parentRef').textContent).toBe('');
    expect($('#refGroups [aria-label="Waits on"] .refGroupLabel').textContent).toBe('Waits on');
    const chips = document.querySelectorAll('#refGroups .k-ticket-ref');
    expect(chips).toHaveLength(2);
    expect(chips[1]!.querySelector('a')).toBeNull();
    const link = $('#refGroups a[data-act="open-dependency"]');
    expect(link.getAttribute('data-ticket')).toBe('42');
    expect(fireEvent.click(link)).toBe(false);
    fireEvent.click(link);
    expect(h.send.openDependency).toHaveBeenCalledTimes(1);
    expect(h.send.openDependency).toHaveBeenCalledWith(42, 'req-1');
  });

  it('renders a proposal-only blocker as an inline plain chip, not a whole-chip button', () => {
    mountHeader(headerState({ blockers: [ticketRefView({ draftId: 94 })] }));
    const chip = $('#refGroups .k-ticket-ref')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toContain('D94');
    expect(chip.textContent).not.toContain('Blocked by');
    expect(document.querySelector('#refGroups button')).toBeNull();
    expect(chip.querySelector('a')).toBeNull();
  });
});

describe('HeaderMeta — Waits on and Unblocks', () => {
  it('draws Waits on chips, a divider, then Unblocks chips, and never the old words', () => {
    mountHeader(headerState({ blockers: [ticketRefView({ ticketId: 42, idLabel: 'T42' })], unblocks: [ticketRefView({ draftId: 7 })] }));
    expect(row().hidden).toBe(false);
    const kids = [...$('#refGroups').children];
    expect(kids.map((k) => k.className)).toEqual(['refGroup', 'refDivider', 'refGroup']);
    expect(kids[0]!.getAttribute('aria-label')).toBe('Waits on');
    expect(kids[2]!.getAttribute('aria-label')).toBe('Unblocks');
    expect(kids[2]!.textContent).toContain('D7');
    expect($('#headerMeta').textContent).not.toMatch(/Blocked by|Blocks/);
  });

  it('hides the Unblocks group, and the divider, when it is empty', () => {
    mountHeader(headerState({ blockers: [ticketRefView({ ticketId: 42, idLabel: 'T42' })], unblocks: [] }));
    expect(document.querySelector('.refDivider')).toBeNull();
    expect(document.querySelector('[aria-label="Unblocks"]')).toBeNull();
  });

  it('shows the row for Unblocks alone', () => {
    mountHeader(headerState({ unblocks: [ticketRefView({ ticketId: 9, idLabel: 'T9' })] }));
    expect(row().hidden).toBe(false);
    expect(document.querySelector('[aria-label="Waits on"]')).toBeNull();
  });
});

describe('HeaderMeta — relations only (T1413)', () => {
  const catalog = { claude: [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }] };

  it('stays hidden when a differing capability is the only fact; the Models button carries it in row 1', () => {
    mountHeader(headerState({ agentSwitch: { ...headerState().agentSwitch, modelsByCore: catalog }, capabilityIdentity: caps({ uatTester: { provider: 'claude', model: 'm2' }, review: { provider: 'claude', model: 'm2' } }) }));
    expect(row().hidden).toBe(true);
    expect(document.querySelector('#capabilityLabels')).toBeNull();
    expect(document.querySelector('.headerActions #modelsBtn')).not.toBeNull();
  });

  it('draws no row-2 chip for a graph ticket, and still shows its Models button in row 1', () => {
    mountHeader(
      headerState({
        capabilityIdentity: caps({
          graphExpert: { provider: 'claude', model: 'm2' },
          graphWorker: { provider: 'claude', model: 'm1' },
          graphFast: { provider: 'claude', model: 'm1' },
        }),
      }),
    );
    expect(row().hidden).toBe(true);
    expect(document.querySelectorAll('#headerMeta .capChip')).toHaveLength(0);
    expect(document.querySelector('.headerActions #modelsBtn')).not.toBeNull();
  });
});
