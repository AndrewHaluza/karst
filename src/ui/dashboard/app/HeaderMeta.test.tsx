// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { $, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';

installHeaderDoubles();

const caps = (over: Record<string, unknown>) => ({ implementation: { provider: 'claude', model: 'm1' }, uatTester: null, review: null, ...over });
const row = (): HTMLElement => $('#headerMeta');

describe('HeaderMeta — relations', () => {
  it('is hidden with no relation and no differing capability', () => {
    mountHeader(headerState());
    expect(row().hidden).toBe(true);
    expect($('#parentRef').hidden).toBe(true);
  });

  it('joins origin, sub-task and follow-up relations with a dot, in one text run', () => {
    mountHeader(headerState({ origin: 'from D88', subtaskParent: { key: 'A', ref: 'T1 · A', title: null }, parent: { key: 'B', ref: 'T2 · B', title: null } }));
    expect(row().hidden).toBe(false);
    expect($('#parentRef').textContent).toBe('from D88 · Sub-task of T1 · A · Follow-up of T2 · B');
    expect($('#parentRef').childNodes).toHaveLength(1);
  });

  it('draws blockers as chips, linking only those with a ticket, and posts the dependency once', () => {
    const h = mountHeader(
      headerState({ origin: 'from D88', blockers: [{ ticketId: 42, idLabel: 'T42', label: 'CU-1' }, { ticketId: null, idLabel: null, label: 'external' }] }),
    );
    expect($('#parentRef').textContent).toBe('from D88 · Blocked by T42 · CU-1 · Blocked by external');
    const chips = document.querySelectorAll('#parentRef .k-chip');
    expect(chips).toHaveLength(2);
    expect(chips[1]!.querySelector('a')).toBeNull();
    const link = $('#parentRef a[data-act="open-dependency"]');
    expect(link.getAttribute('data-ticket')).toBe('42');
    expect(fireEvent.click(link)).toBe(false);
    fireEvent.click(link);
    expect(h.send.openDependency).toHaveBeenCalledTimes(1);
    expect(h.send.openDependency).toHaveBeenCalledWith(42, 'req-1');
  });
});

describe('HeaderMeta — capability chips', () => {
  const catalog = { claude: [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }] };

  it('omits roles that match implementation', () => {
    mountHeader(headerState({ capabilityIdentity: caps({ uatTester: { provider: 'claude', model: 'm1' } }) }));
    expect(row().hidden).toBe(true);
    expect($('#capabilityLabels').childElementCount).toBe(0);
  });

  it('groups roles that share a differing identity into one chip with the catalog label', () => {
    mountHeader(
      headerState({
        agentSwitch: { ...headerState().agentSwitch, modelsByCore: catalog },
        capabilityIdentity: caps({ uatTester: { provider: 'claude', model: 'm2' }, review: { provider: 'claude', model: 'm2' } }),
      }),
    );
    expect(row().hidden).toBe(false);
    const chips = document.querySelectorAll('#capabilityLabels .capChip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.getAttribute('title')).toBe('UAT · Review: claude/m2');
    expect(chips[0]!.querySelector('.capModel')!.textContent).toBe('Model Two');
    expect(chips[0]!.querySelector('.agenticon')).toBeTruthy();
  });

  it('falls back to the model id when the catalog has no label', () => {
    mountHeader(headerState({ capabilityIdentity: caps({ review: { provider: 'opencode', model: 'x/y' } }) }));
    expect($('.capModel').textContent).toBe('x/y');
  });
});
