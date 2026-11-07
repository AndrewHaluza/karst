// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { agentPickerJs } from './agentPicker.js';
import { agentIdentityJs } from './agentIdentity.js';

/**
 * The registry-driven core list, the capability tabs and the staged "Switch
 * agent" mode of the shared picker (T1011). The picker is built from the
 * shipped JS string exactly as the hosts run it.
 */
const js = agentPickerJs();

type Value = { core: string; model: string; effort: string };
type Picker = { getValue: () => Value };
type Mount = (root: HTMLElement, opts: Record<string, unknown>) => Picker;

const CORES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'opencode2', label: 'OpenCode 2', disabledReason: 'not installed' },
];

const CATALOG = {
  claude: [
    { id: 'claude-opus-5', label: 'Opus 5', efforts: ['low', 'high'], tags: ['vision', 'multimodal'] },
    { id: 'claude-haiku-5', label: 'Haiku 5', efforts: ['low'], tags: ['vision'] },
  ],
  codex: [{ id: 'gpt-6', label: 'GPT 6', efforts: ['low', 'medium', 'high'], tags: ['text-only'] }],
  antigravity: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro', efforts: ['low', 'high'], tags: ['vision', 'audio'] }],
  opencode: [
    { id: 'opencode/big-pickle', label: 'Big Pickle', tags: ['text-only'] },
    { id: 'opencode/kimi-k3-free', label: 'Kimi K3', tags: ['text-only'] },
    { id: 'opencode-go/mimo-v2.5', label: 'MiMo v2.5', tags: ['vision', 'multimodal'] },
    { id: 'openrouter/google/gemini-3-pro', label: 'Gemini 3 Pro', efforts: ['low', 'high'], tags: ['vision', 'audio'] },
  ],
};

const ROUTES = {
  opencode: { name: 'OpenCode Zen', badge: 'Z', billing: 'subscription', iconSvg: '<svg data-r="zen"></svg>' },
  'opencode-go': { name: 'OpenCode Go', badge: 'Go', billing: 'subscription', iconSvg: '<svg data-r="go"></svg>' },
  openrouter: { name: 'OpenRouter', billing: 'api-key', iconSvg: '<svg data-r="or"></svg>' },
};

function load(): Mount {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return (new Function(`${agentIdentityJs()}\n${js}\nreturn mountAgentPicker;`)() as Mount);
}

interface Handlers {
  onChange: ReturnType<typeof vi.fn>;
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
}

function mountStaged(extra: Record<string, unknown> = {}, width = 800) {
  const root = document.createElement('div');
  Object.defineProperty(root, 'clientWidth', { value: width, configurable: true });
  document.body.append(root);
  const h: Handlers = { onChange: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
  const picker = load()(root, {
    mode: 'staged',
    cores: CORES,
    currentCore: 'claude',
    catalog: CATALOG,
    routes: ROUTES,
    recent: { opencode: ['opencode-go/mimo-v2.5'], claude: [] },
    value: { core: 'claude', model: 'claude-opus-5', effort: 'high' },
    ...h,
    ...extra,
  });
  return { root, picker, ...h };
}

const click = (el: Element | null): void => {
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const key = (el: Element, name: string): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
};
const coreTabs = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-ap-core-tab]')];
const capTabs = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-ap-cap]')];
const rows = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-ap-list="model"] [role="option"]')];
const rowIds = (root: HTMLElement): (string | null)[] => rows(root).map((r) => r.getAttribute('data-ap-model'));
const search = (root: HTMLElement): HTMLInputElement => root.querySelector('[data-ap-search]')!;
const type = (root: HTMLElement, q: string): void => {
  const input = search(root);
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const commitBtn = (root: HTMLElement): HTMLButtonElement => root.querySelector('[data-ap-commit]')!;
const capLabel = (t: HTMLElement): string => (t.getAttribute('data-ap-cap') ?? '') + ':' + (t.querySelector('.ap-cap-n')?.textContent ?? '');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('core list is built only from opts.cores', () => {
  it('renders one tab per core in the order given, with its label', () => {
    const { root } = mountStaged();
    expect(coreTabs(root).map((t) => t.getAttribute('data-ap-core-tab'))).toEqual(
      CORES.map((c) => c.id),
    );
    expect(coreTabs(root)[3]!.textContent).toContain('OpenCode');
  });

  it('a core added later appears without a picker change, and a removed one disappears', () => {
    const { root } = mountStaged({ cores: [{ id: 'newcore', label: 'New Core' }, CORES[0]] });
    expect(coreTabs(root).map((t) => t.getAttribute('data-ap-core-tab'))).toEqual(['newcore', 'claude']);
  });

  it('marks the running session core "current"', () => {
    const { root } = mountStaged();
    expect(coreTabs(root)[0]!.querySelector('small')!.textContent).toBe('current');
    expect(coreTabs(root)[1]!.querySelector('small')).toBeNull();
  });

  it('renders an unavailable core disabled with its reason as sub-label', () => {
    const { root } = mountStaged();
    const off = coreTabs(root)[4]!;
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(off.querySelector('small')!.textContent).toBe('not installed');
    click(off);
    expect(coreTabs(root)[4]!.getAttribute('aria-selected')).toBe('false');
  });

  it('never renders a native select for the core, at any width', () => {
    for (const w of [900, 500, 320]) {
      document.body.innerHTML = '';
      const { root } = mountStaged({}, w);
      expect(root.querySelector('select'), `select at ${w}px`).toBeNull();
    }
  });

  it('is a vertical tablist at 660px and above', () => {
    const { root } = mountStaged({}, 660);
    const list = root.querySelector('[data-ap-cores]')!;
    expect(list.getAttribute('role')).toBe('tablist');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('is a horizontal tablist below 660px with the same items', () => {
    const { root } = mountStaged({}, 659);
    const list = root.querySelector('[data-ap-cores]')!;
    expect(list.getAttribute('role')).toBe('tablist');
    expect(list.getAttribute('aria-orientation')).toBe('horizontal');
    expect(coreTabs(root)).toHaveLength(CORES.length);
  });

  it('shows every core icon through the identity helper', () => {
    const { root } = mountStaged();
    for (const t of coreTabs(root)) expect(t.querySelector('svg, img, .agentbadge, [class*="agent"]')).not.toBeNull();
  });
});

describe('core keyboard', () => {
  it('ArrowDown skips a disabled core and Home/End jump to the enabled ends', () => {
    const { root } = mountStaged();
    const tabs = coreTabs(root);
    tabs[3]!.focus();
    key(tabs[3]!, 'ArrowDown'); // opencode2 is disabled -> wraps past it
    expect(document.activeElement).toBe(coreTabs(root)[0]);
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(coreTabs(root)[3]);
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(coreTabs(root)[0]);
  });

  it('Enter and Space select the focused core', () => {
    const { root } = mountStaged();
    coreTabs(root)[1]!.focus();
    key(coreTabs(root)[1]!, 'Enter');
    expect(coreTabs(root)[1]!.getAttribute('aria-selected')).toBe('true');
    coreTabs(root)[2]!.focus();
    key(coreTabs(root)[2]!, ' ');
    expect(coreTabs(root)[2]!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('picking a core', () => {
  it('switches the list to that catalog, resets the capability tab and stages the first Last-used model', () => {
    const { root } = mountStaged();
    click(capTabs(root).find((t) => t.getAttribute('data-ap-cap') === 'vision')!);
    click(coreTabs(root)[3]!);
    expect(rowIds(root)).toContain('opencode/big-pickle');
    expect(rowIds(root)).not.toContain('claude-opus-5');
    const selectedCap = capTabs(root).find((t) => t.getAttribute('aria-selected') === 'true')!;
    expect(selectedCap.getAttribute('data-ap-cap')).toBe('all');
    expect(root.querySelector('[data-ap-list="model"] [aria-selected="true"]')!.getAttribute('data-ap-model')).toBe(
      'opencode-go/mimo-v2.5',
    );
  });

  it('stages the first catalog model when the core has no Last-used model', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[1]!);
    expect(root.querySelector('[data-ap-list="model"] [aria-selected="true"]')!.getAttribute('data-ap-model')).toBe('gpt-6');
  });

  it('is staged: a pick never calls onChange', () => {
    const { root, onChange } = mountStaged();
    click(coreTabs(root)[1]!);
    click(rows(root)[0]!);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('capability tabs', () => {
  const tabs = (root: HTMLElement) => capTabs(root).map(capLabel);

  it('shows All plus only the capabilities some model of the core has, with live counts', () => {
    const { root } = mountStaged({}, 800);
    click(coreTabs(root)[3]!);
    expect(tabs(root)).toEqual(['all:4', 'vision:2', 'multimodal:1', 'audio:1', 'text-only:2', 'free:1']);
    click(coreTabs(root)[0]!);
    expect(tabs(root)).toEqual(['all:2', 'vision:2', 'multimodal:1']);
  });

  it('counts follow the current search and keep a zero-count tab visible but dimmed', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    type(root, 'kimi');
    expect(tabs(root)).toEqual(['all:1', 'vision:0', 'multimodal:0', 'audio:0', 'text-only:1', 'free:1']);
    const vision = capTabs(root).find((t) => t.getAttribute('data-ap-cap') === 'vision')!;
    expect(vision.getAttribute('aria-disabled')).toBe('true');
    const textOnly = capTabs(root).find((t) => t.getAttribute('data-ap-cap') === 'text-only')!;
    expect(textOnly.getAttribute('aria-disabled')).toBeNull();
  });

  it('filters the list by the chosen capability; Free uses the free flag', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    click(capTabs(root).find((t) => t.getAttribute('data-ap-cap') === 'free')!);
    expect(rowIds(root)).toEqual(['opencode/kimi-k3-free']);
    click(capTabs(root).find((t) => t.getAttribute('data-ap-cap') === 'audio')!);
    expect(rowIds(root)).toEqual(['openrouter/google/gemini-3-pro']);
  });

  it('clicking a dimmed tab does nothing', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    type(root, 'kimi');
    click(capTabs(root).find((t) => t.getAttribute('data-ap-cap') === 'vision')!);
    expect(capTabs(root).find((t) => t.getAttribute('aria-selected') === 'true')!.getAttribute('data-ap-cap')).toBe('all');
  });

  it('is a tablist whose arrow keys move between the tabs', () => {
    const { root } = mountStaged();
    expect(root.querySelector('[data-ap-caps]')!.getAttribute('role')).toBe('tablist');
    const first = capTabs(root)[0]!;
    first.focus();
    key(first, 'ArrowRight');
    expect(document.activeElement).toBe(capTabs(root)[1]);
  });

  it('renders the empty message with query and capability', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    click(capTabs(root).find((t) => t.getAttribute('data-ap-cap') === 'audio')!);
    type(root, 'zzz');
    expect(root.querySelector('.ap-empty')!.textContent).toBe('No models match "zzz" in Audio.');
  });
});

describe('model list', () => {
  it('puts Last used first, each row with its route mark; hides it while searching', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    const first = rows(root)[0]!;
    expect(first.getAttribute('data-ap-model')).toBe('opencode-go/mimo-v2.5');
    expect(first.querySelector('.ap-route svg[data-r="go"]')).not.toBeNull();
    expect(first.querySelector('.ap-route-badge')!.textContent).toBe('Go');
    expect(root.querySelector('[data-ap-list="model"]')!.textContent).toContain('Last used');
    type(root, 'mimo');
    expect(root.querySelector('[data-ap-list="model"]')!.textContent).not.toContain('Last used');
  });

  it('shows subscription vs API key in each route group header', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    const heads = [...root.querySelectorAll('[data-ap-list="model"] .ap-group-label')].map((h) => h.textContent);
    expect(heads.find((t) => t!.includes('OpenCode Zen'))).toContain('subscription');
    expect(heads.find((t) => t!.includes('OpenRouter'))).toContain('API key');
  });

  it('row: check on the staged model, free tag, current tag, capability tags', () => {
    const { root } = mountStaged();
    const staged = root.querySelector('[aria-selected="true"][data-ap-model]')!;
    expect(staged.getAttribute('data-ap-model')).toBe('claude-opus-5');
    expect(staged.querySelector('.ap-ck')).not.toBeNull();
    expect(staged.querySelector('.ap-cur')!.textContent).toBe('current');
    expect(staged.textContent).toContain('multimodal');
    click(coreTabs(root)[3]!);
    const free = root.querySelector('[data-ap-model="opencode/kimi-k3-free"]')!;
    expect(free.querySelector('.ap-free')!.textContent).toBe('free');
    expect(free.querySelector('.ap-cur')).toBeNull();
  });

  it('search wraps the match in <mark>, by name, id, vendor and route name', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    type(root, 'pickle');
    expect(root.querySelector('[data-ap-model="opencode/big-pickle"] mark')!.textContent!.toLowerCase()).toBe('pickle');
    type(root, 'openrouter');
    expect(rowIds(root)).toEqual(['openrouter/google/gemini-3-pro']);
    type(root, 'google');
    expect(rowIds(root)).toEqual(['openrouter/google/gemini-3-pro']);
  });

  it('search placeholder is "Search models"', () => {
    const { root } = mountStaged();
    expect(search(root).getAttribute('placeholder')).toBe('Search models');
  });

  it('Esc clears a non-empty query; a second Esc cancels', () => {
    const { root, onCancel } = mountStaged();
    type(root, 'opus');
    key(search(root), 'Escape');
    expect(search(root).value).toBe('');
    expect(onCancel).not.toHaveBeenCalled();
    key(search(root), 'Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ArrowDown from search enters the list; ArrowUp/Down move within it; Enter picks', () => {
    const { root } = mountStaged();
    key(search(root), 'ArrowDown');
    expect(document.activeElement).toBe(rows(root)[0]);
    key(rows(root)[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(rows(root)[1]);
    key(rows(root)[1]!, 'Enter');
    expect(root.querySelector('[data-ap-list="model"] [aria-selected="true"]')!.getAttribute('data-ap-model')).toBe(
      'claude-haiku-5',
    );
  });
});

describe('effort', () => {
  it('offers only the efforts the staged model advertises', () => {
    const { root } = mountStaged();
    const btns = [...root.querySelectorAll('[data-ap-effort-opt]')].map((b) => b.getAttribute('data-ap-effort-opt'));
    expect(btns).toEqual(['low', 'high']);
    expect(root.querySelector('[data-ap-effort-opt="high"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a model without efforts shows the text and no control', () => {
    const { root } = mountStaged();
    click(coreTabs(root)[3]!);
    click(root.querySelector('[data-ap-model="opencode/big-pickle"]'));
    expect(root.querySelector('[data-ap-effort-opt]')).toBeNull();
    expect(root.querySelector('[data-ap-effort-row]')!.textContent).toContain('— this model has no effort levels');
  });

  it('showEffort false hides the effort row entirely', () => {
    const { root } = mountStaged({ showEffort: false });
    expect(root.querySelector('[data-ap-effort-row]')).toBeNull();
  });
});

describe('footer and staged commit', () => {
  it('footer shows the full id in monospace with title = id', () => {
    const { root } = mountStaged();
    const fid = root.querySelector('[data-ap-fid]')!;
    expect(fid.textContent).toBe('claude-opus-5');
    expect(fid.getAttribute('title')).toBe('claude-opus-5');
  });

  it('Switch agent is disabled until core, model or effort differs', () => {
    const { root } = mountStaged();
    expect(commitBtn(root).textContent).toBe('Switch agent');
    expect(commitBtn(root).disabled).toBe(true);
    click(root.querySelector('[data-ap-effort-opt="low"]'));
    expect(commitBtn(root).disabled).toBe(false);
    click(root.querySelector('[data-ap-effort-opt="high"]'));
    expect(commitBtn(root).disabled).toBe(true);
    click(root.querySelector('[data-ap-model="claude-haiku-5"]'));
    expect(commitBtn(root).disabled).toBe(false);
  });

  it('onCommit receives exactly {core, model, effort}', () => {
    const { root, onCommit, onChange } = mountStaged();
    click(coreTabs(root)[2]!);
    click(root.querySelector('[data-ap-effort-opt="low"]'));
    click(commitBtn(root));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ core: 'antigravity', model: 'gemini-3-pro', effort: 'low' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a disabled commit button does not commit', () => {
    const { root, onCommit } = mountStaged();
    click(commitBtn(root));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Cancel calls onCancel and commits nothing', () => {
    const { root, onCancel, onCommit } = mountStaged();
    click(root.querySelector('[data-ap-cancel]'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('inline mode is the default and keeps its triggers', () => {
  it('renders the trigger layout, no staged panel, and calls onChange per pick', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const onChange = vi.fn();
    load()(root, {
      cores: CORES.slice(0, 4),
      catalog: CATALOG,
      value: { core: 'codex', model: 'gpt-6', effort: '' },
      onChange,
    });
    expect(root.querySelector('[data-ap-trigger="core"]')).not.toBeNull();
    expect(root.querySelector('[data-ap-commit]')).toBeNull();
    expect(root.querySelector('[data-ap-cores]')).toBeNull();
    click(root.querySelector('[data-ap-trigger="model"]'));
    click(root.querySelector('[data-ap-model="gpt-6"]'));
    expect(onChange).toHaveBeenCalledWith({ core: 'codex', model: 'gpt-6', effort: '' });
  });

  it('the inline model menu gains capability tabs for the selected core', () => {
    const root = document.createElement('div');
    document.body.append(root);
    load()(root, {
      cores: CORES.slice(0, 4),
      catalog: CATALOG,
      value: { core: 'claude', model: 'claude-opus-5', effort: '' },
    });
    click(root.querySelector('[data-ap-trigger="model"]'));
    expect(capTabs(root).map(capLabel)).toEqual(['all:2', 'vision:2', 'multimodal:1']);
    click(capTabs(root)[2]!);
    expect(rowIds(root).filter((i) => i)).toEqual(['claude-opus-5']);
  });
});
