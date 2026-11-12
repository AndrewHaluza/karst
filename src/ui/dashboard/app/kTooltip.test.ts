// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTooltip, TOOLTIP_ID } from './kTooltip.js';

describe('k-tooltip', () => {
  let uninstall: () => void;
  let btn: HTMLButtonElement;
  const tip = () => document.getElementById(TOOLTIP_ID);

  beforeEach(() => {
    document.body.innerHTML = '<button id="b" data-tip="Claude Code · Model A" aria-label="Claude Code">x</button><button id="plain">y</button>';
    btn = document.getElementById('b') as HTMLButtonElement;
    uninstall = installTooltip(document);
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = '';
  });

  it('shows on pointer hover with the data-tip text and wires aria-describedby', () => {
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tip()?.textContent).toBe('Claude Code · Model A');
    expect(tip()?.getAttribute('role')).toBe('tooltip');
    expect(btn.getAttribute('aria-describedby')).toBe(TOOLTIP_ID);
  });

  it('shows on keyboard focus and hides on blur', () => {
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tip()?.hidden).toBe(false);
    btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(tip()?.hidden).toBe(true);
    expect(btn.hasAttribute('aria-describedby')).toBe(false);
  });

  it('hides on pointer leave', () => {
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(tip()?.hidden).toBe(true);
  });

  it('hides on Escape without moving focus', () => {
    btn.focus();
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tip()?.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('ignores elements without data-tip and keeps one tooltip node', () => {
    document.getElementById('plain')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tip()).toBeNull();
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.querySelectorAll(`#${TOOLTIP_ID}`)).toHaveLength(1);
  });

  it('removes its node and listeners on uninstall', () => {
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    uninstall();
    expect(tip()).toBeNull();
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(tip()).toBeNull();
  });
});
