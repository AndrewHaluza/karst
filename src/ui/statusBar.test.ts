import { describe, it, expect } from 'vitest';
import {
  statusBarText,
  StatusBarManager,
  type StatusBarHost,
  type StatusTicket,
} from './statusBar.js';

const base: StatusTicket = {
  ticketId: 7,
  key: 'KAR-7',
  stage: 'review',
  glyph: 'blue',
};

describe('statusBarText', () => {
  it('renders one ref, the stage title and the glyph word (SB-4)', () => {
    expect(statusBarText(base)).toBe('T7 · KAR-7 · Review · Running');
  });

  it('formats the ref once — the key arrives raw, so it is never "T7 · T7"', () => {
    expect(statusBarText(base)).toContain('T7 · KAR-7');
    expect(statusBarText(base).match(/T7/g)).toHaveLength(1);
    const raw = statusBarText({ ...base, key: 'ABC-12', stage: 'none' });
    expect(raw).toBe('T7 · ABC-12 · Running');
    expect(raw.match(/T7/g)).toHaveLength(1);
  });

  it('shows the stage word, not the raw stage id', () => {
    expect(statusBarText({ ...base, stage: 'uat' })).toBe('T7 · KAR-7 · UAT · Running');
    expect(statusBarText({ ...base, stage: 'impl' })).toBe('T7 · KAR-7 · Implementation · Running');
    // An unknown stage key still passes through rather than blank out.
    expect(statusBarText({ ...base, stage: 'promote' })).toBe('T7 · KAR-7 · promote · Running');
  });

  it('omits the stage part when the stage is none (DB-K1)', () => {
    expect(statusBarText({ ...base, stage: 'none' })).toBe('T7 · KAR-7 · Running');
  });

  it('reads the state word from GLYPH_WORD (SB-13)', () => {
    expect(statusBarText({ ...base, glyph: 'amber' })).toBe('T7 · KAR-7 · Review · Needs you');
    expect(statusBarText({ ...base, glyph: 'green' })).toBe('T7 · KAR-7 · Review · Done');
    expect(statusBarText({ ...base, glyph: 'gray' })).toBe('T7 · KAR-7 · Review · Pending');
    expect(statusBarText({ ...base, glyph: 'red' })).toBe('⚠ T7 · KAR-7 · Review · Failed');
  });

  it('shows just T<n> for a keyless ticket', () => {
    expect(statusBarText({ ...base, key: '' })).toBe('T7 · Review · Running');
  });

  it('prefixes a warning glyph when blocked (red)', () => {
    expect(statusBarText({ ...base, stage: 'fix', glyph: 'red' })).toBe(
      '⚠ T7 · KAR-7 · Fix · Failed',
    );
  });
});

describe('StatusBarManager', () => {
  it('sets text + warning + click command, hides on null', () => {
    const calls: Array<{ text: string; warning: boolean; cmd: unknown } | 'hide'> = [];
    const host: StatusBarHost = {
      set: (text, warning, command) => calls.push({ text, warning, cmd: command.arg }),
      hide: () => calls.push('hide'),
    };
    const m = new StatusBarManager(host);
    m.render({ ...base, glyph: 'red', stage: 'fix' });
    m.render(null);
    expect(calls[0]).toEqual({ text: '⚠ T7 · KAR-7 · Fix · Failed', warning: true, cmd: 7 });
    expect(calls[1]).toBe('hide');
  });

  it('a non-red glyph is not a warning', () => {
    const warnings: boolean[] = [];
    const host: StatusBarHost = {
      set: (_t, warning) => warnings.push(warning),
      hide: () => {},
    };
    new StatusBarManager(host).render({ ...base, glyph: 'amber' });
    expect(warnings).toEqual([false]);
  });
});
