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
  const optsA = {
    cores: ['opencode'],
    catalog,
    value: { core: 'opencode', model: 'opencode/big-pickle' },
    onChange: (v: Changed) => changed.push('a:' + v.model),
  };
  mountAgentPicker(a, optsA);
  mountAgentPicker(b, {
    cores: ['opencode'],
    catalog,
    value: { core: 'opencode', model: 'opencode/big-pickle' },
    onChange: (v: Changed) => changed.push('b:' + v.model),
  });
  return { a, b, changed, mount: mountAgentPicker, optsA };
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

describe('a picker only answers keys from its open menu', () => {
  // The open menu's keys belong to the menu (or the trigger that owns it).
  // Any other control in the SAME picker root must keep its own keyboard.
  it('does not commit the open menu’s row on Enter from another control', () => {
    const { a, changed } = mountBoth();
    click(trigger(a, 'model'));
    const before = activeId(a);

    key(trigger(a, 'core'), 'Enter');

    expect(changed).toEqual([]);
    expect(activeId(a)).toBe(before);
    expect(menu(a).hidden, 'the model menu stayed open').toBe(false);
  });

  it('does not move the open menu’s active row from another control', () => {
    const { a } = mountBoth();
    click(trigger(a, 'model'));
    const before = activeId(a);

    key(trigger(a, 'core'), 'ArrowDown');

    expect(activeId(a)).toBe(before);
  });

  it('still closes its own open menu on Escape from another control', () => {
    // Escape is a dismissal, not a menu action: it belongs to the whole picker,
    // even when focus sits on the core trigger while the model menu is open.
    const { a } = mountBoth();
    click(trigger(a, 'model'));
    const core = trigger(a, 'core');
    (core as HTMLElement).focus();

    key(core, 'Escape');

    expect(menu(a).hidden).toBe(true);
    expect(document.activeElement).toBe(trigger(a, 'model'));
  });
});

describe('a picker chooses the row the key came from', () => {
  // Rows are tabbable (`tabindex="0"`), so DOM focus can sit on a row the
  // highlight does not cover (openMenu focuses the search box and highlights
  // the saved row). Enter must choose the focused row, never the highlight.
  const rows = (root: HTMLElement): Element[] =>
    Array.from(menu(root).querySelectorAll('[role="option"]'));
  const foot = (root: HTMLElement): string =>
    root.querySelector('[data-ap-foot]')?.textContent ?? '';

  it('commits the focused row on Enter, not the highlighted one', () => {
    const { a, changed } = mountBoth();
    click(trigger(a, 'model'));
    expect(activeId(a)).toBe('opencode/big-pickle');

    const go = rows(a)[1]!;
    (go as HTMLElement).focus();
    expect(document.activeElement).toBe(go);

    key(go, 'Enter');

    expect(changed).toEqual(['a:opencode-go/deepseek-v4.1-flash']);
    expect(menu(a).hidden).toBe(true);
  });

  it('still commits the highlighted row when Enter comes from the search box', () => {
    const { a, changed } = mountBoth();
    click(trigger(a, 'model'));
    const search = menu(a).querySelector('[data-ap-search]')!;
    (search as HTMLElement).focus();

    key(search, 'Enter');

    expect(changed).toEqual(['a:opencode/big-pickle']);
    expect(menu(a).hidden).toBe(true);
  });

  it('points the highlight and footer at the row focus lands on', () => {
    const { a } = mountBoth();
    click(trigger(a, 'model'));
    const go = rows(a)[1]!;

    (go as HTMLElement).focus();

    expect(activeId(a)).toBe('opencode-go/deepseek-v4.1-flash');
    expect(foot(a)).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('moves focus with the highlight when arrowing from a focused row', () => {
    const { a } = mountBoth();
    click(trigger(a, 'model'));
    const first = rows(a)[0]!;
    (first as HTMLElement).focus();

    key(first, 'ArrowDown');

    expect(activeId(a)).toBe('opencode-go/deepseek-v4.1-flash');
    expect(document.activeElement).toBe(rows(a)[1]);
  });
});

describe('a host re-mount keeps the open menu usable', () => {
  // Hosts re-mount onto the same root on every state push (an idempotent
  // `_configure` + `setValue`, which re-renders the menu HTML). A menu the user
  // has open must survive that: if the focused search box is replaced, focus
  // falls to the document body and the keydown listener never sees a key again.
  const search = (root: HTMLElement): HTMLElement =>
    menu(root).querySelector('[data-ap-search]') as HTMLElement;

  it('keeps the menu open and the search box focused', () => {
    const { a, mount, optsA } = mountBoth();
    click(trigger(a, 'model'));
    search(a).focus();

    mount(a, optsA);

    expect(menu(a).hidden).toBe(false);
    expect(document.activeElement).toBe(search(a));
    key(search(a), 'ArrowDown');
    expect(activeId(a)).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('gives focus back to the row that had it', () => {
    const { a, mount, optsA } = mountBoth();
    click(trigger(a, 'model'));
    const go = menu(a).querySelectorAll('[role="option"]')[1] as HTMLElement;
    go.focus();

    mount(a, optsA);

    expect(menu(a).hidden).toBe(false);
    expect(document.activeElement).toBe(menu(a).querySelectorAll('[role="option"]')[1]);
    expect(activeId(a)).toBe('opencode-go/deepseek-v4.1-flash');
  });
});
