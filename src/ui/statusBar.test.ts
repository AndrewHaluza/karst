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
  state: 'running',
  glyph: 'blue',
};

describe('statusBarText', () => {
  it('renders key · stage · state', () => {
    expect(statusBarText(base)).toBe('KAR-7 · review · running');
  });
  it('prefixes a warning glyph when blocked (red)', () => {
    expect(statusBarText({ ...base, stage: 'fix', state: 'idle', glyph: 'red' })).toBe(
      '⚠ KAR-7 · fix · idle',
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
    expect(calls[0]).toEqual({ text: '⚠ KAR-7 · fix · running', warning: true, cmd: 7 });
    expect(calls[1]).toBe('hide');
  });

  it('a non-red glyph is not a warning', () => {
    const warnings: boolean[] = [];
    const host: StatusBarHost = {
      set: (_t, warning) => warnings.push(warning),
      hide: () => {},
    };
    new StatusBarManager(host).render({ ...base, glyph: 'amber', state: 'waiting' });
    expect(warnings).toEqual([false]);
  });
});
