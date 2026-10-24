// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { agentPickerJs } from './agentPicker.js';
import { agentIdentityJs } from './agentIdentity.js';

/**
 * The keyboard bug the review found was cross-picker, so it can only be pinned
 * by TWO live pickers in one document. The pure `apMenuShellFor` test in
 * agentPicker.test.ts proves the helper's selection rule; this file proves the
 * mounted wiring uses it: a key pressed in picker B must never move, choose or
 * close picker A's open menu.
 *
 * The picker is built from the shipped JS string exactly as the hosts run it.
 */
const js = agentPickerJs();

type Changed = { core: string; model: string; effort: string };
type Mount = (root: HTMLElement, opts: Record<string, unknown>) => unknown;

function mountBoth() {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const { mountAgentPicker } = new Function(
    `${agentIdentityJs()}\n${js}\nreturn { mountAgentPicker };`,
  )() as { mountAgentPicker: Mount };

  const catalog = {
    opencode: [
      { id: 'opencode/big-pickle', label: 'Big Pickle' },
      { id: 'opencode-go/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
    ],
  };
  const a = document.createElement('div');
  const b = document.createElement('div');
  document.body.append(a, b);
  const changed: string[] = [];
  mountAgentPicker(a, {
    cores: ['opencode'],
    catalog,
    value: { core: 'opencode', model: 'opencode/big-pickle' },
    onChange: (v: Changed) => changed.push('a:' + v.model),
  });
  mountAgentPicker(b, {
    cores: ['opencode'],
    catalog,
    value: { core: 'opencode', model: 'opencode/big-pickle' },
    onChange: (v: Changed) => changed.push('b:' + v.model),
  });
  return { a, b, changed };
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function key(el: Element, name: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
}

const trigger = (root: HTMLElement, kind: string): Element =>
  root.querySelector(`[data-ap-trigger="${kind}"]`)!;
const menu = (root: HTMLElement): HTMLElement =>
  root.querySelector('[data-ap-menu="model"]') as HTMLElement;
const activeId = (root: HTMLElement): string | null =>
  root.querySelector('[role="option"].active')?.getAttribute('data-ap-model') ?? null;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a mounted picker only answers keys for its own menu', () => {
  it('still moves its own active row with the arrow keys', () => {
    // Guard against "scoped so hard that the picker itself stopped working".
    const { a } = mountBoth();
    click(trigger(a, 'model'));
    expect(menu(a).hidden).toBe(false);
    expect(activeId(a)).toBe('opencode/big-pickle');
    key(trigger(a, 'model'), 'ArrowDown');
    expect(activeId(a)).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('does not move another picker’s open menu', () => {
    const { a, b } = mountBoth();
    click(trigger(a, 'model'));
    const before = activeId(a);

    // Focus is in B (its trigger); A's menu is the page's only open one.
    key(trigger(b, 'model'), 'ArrowDown');
    key(trigger(b, 'model'), 'ArrowDown');

    expect(activeId(a)).toBe(before);
    expect(menu(a).hidden).toBe(false);
  });

  it('does not choose another picker’s active row on Enter', () => {
    const { a, b, changed } = mountBoth();
    click(trigger(a, 'model'));
    const before = activeId(a);

    key(trigger(b, 'model'), 'Enter');

    expect(changed).toEqual([]);
    expect(activeId(a)).toBe(before);
    expect(menu(a).hidden, 'A’s menu stayed open').toBe(false);
  });

  it('does not close another picker’s menu on Escape', () => {
    const { a, b } = mountBoth();
    click(trigger(a, 'model'));
    key(trigger(b, 'model'), 'Escape');
    expect(menu(a).hidden).toBe(false);
  });
});
