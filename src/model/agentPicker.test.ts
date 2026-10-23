import { describe, it, expect } from 'vitest';
import {
  AGENT_PICKER_CSS_MARKER,
  AGENT_PICKER_JS_MARKER,
  agentPickerCss,
  agentPickerJs,
  injectAgentPicker,
} from './agentPicker.js';
import { agentIdentityJs } from './agentIdentity.js';

/**
 * These tests evaluate the SHIPPED STRING, not a TypeScript re-implementation.
 * The picker's deterministic logic — which options render for a core/model, and
 * when the effort field appears — lives in the pure string-builder functions
 * inside `agentPickerJs()`, so it is exercised here against the real emitted
 * bytes. The DOM wiring (open/close, search, focus) is browser behaviour that
 * this node-only suite cannot exercise and is left to F5 — the same split the
 * design system documents.
 */

const js = agentPickerJs();

function load(): Record<string, unknown> {
  // The picker reuses `agentBadgeHtml`/`agentIdentityHtml` from the injected
  // agent identity runtime, so the emitted agent JS must be in scope too.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${agentIdentityJs()}\n${js}\nreturn {
    apEfforts, apEffortOptions, apCoreOptionsHtml, apModelOptionsHtml,
    apCoreSelection: typeof apCoreSelection === 'function' ? apCoreSelection : undefined,
    apTags, apModelTagsHtml, apInheritLabels, apEffortMode, apModelTriggerName,
    apParseModelId: typeof apParseModelId === 'function' ? apParseModelId : undefined,
    apRouteIconHtml: typeof apRouteIconHtml === 'function' ? apRouteIconHtml : undefined,
    apRouteName: typeof apRouteName === 'function' ? apRouteName : undefined,
    apRouteHue: typeof apRouteHue === 'function' ? apRouteHue : undefined,
    apRoutedTriggerName: typeof apRoutedTriggerName === 'function' ? apRoutedTriggerName : undefined,
    apModelGroups: typeof apModelGroups === 'function' ? apModelGroups : undefined,
    apModelListHtml: typeof apModelListHtml === 'function' ? apModelListHtml : undefined,
    apMarkActive: typeof apMarkActive === 'function' ? apMarkActive : undefined,
    apFilterModels: typeof apFilterModels === 'function' ? apFilterModels : undefined,
    apTriggerLabelHtml: typeof apTriggerLabelHtml === 'function' ? apTriggerLabelHtml : undefined,
    apCoreTriggerName: typeof apCoreTriggerName === 'function' ? apCoreTriggerName : undefined,
  };`)();
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c] as string));
}

const catalog = {
  claude: [
    { id: 'claude-opus-5', label: 'Opus 5', efforts: ['low', 'medium', 'high', 'max'], tags: ['multimodal', 'vision'] },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'], tags: ['text-only'] },
  ],
  codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['minimal', 'low', 'medium', 'high'] }],
  antigravity: [{ id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' }],
  opencode: [],
};

describe('agentPickerJs', () => {
  it('defines the mount function and the pure builders', () => {
    expect(js).toContain('function mountAgentPicker(root, opts)');
    expect(js).toContain('function apEfforts(');
    expect(js).toContain('function apEffortOptions(');
    expect(js).toContain('function apCoreOptionsHtml(');
    expect(js).toContain('function apModelOptionsHtml(');
  });

  it('has a compact mode: screen-reader-only captions, provider-only core trigger', () => {
    expect(js).toContain("var compact = !!o.compact;");
    expect(js).toContain("' ap-compact'");
    expect(js).toContain("apCoreTriggerLabel(state.core, compact ? '' : (coreLabel || ''))");
    expect(agentPickerCss()).toContain('.ap-compact .ap-label{position:absolute');
  });

  it('clears the prior provider model and effort when selecting a different core', () => {
    const { apCoreSelection } = load() as {
      apCoreSelection?: (
        current: { core: string; model: string; effort: string },
        core: string,
      ) => { core: string; model: string; effort: string };
    };

    expect(apCoreSelection).toBeTypeOf('function');
    expect(apCoreSelection!({ core: 'claude', model: 'claude-opus-5', effort: 'high' }, 'codex')).toEqual({
      core: 'codex',
      model: '',
      effort: '',
    });
  });

  it('preserves model and effort when reselecting the current core', () => {
    const { apCoreSelection } = load() as {
      apCoreSelection: (
        current: { core: string; model: string; effort: string },
        core: string,
      ) => { core: string; model: string; effort: string };
    };
    const current = { core: 'claude', model: 'claude-opus-5', effort: 'high' };

    expect(apCoreSelection(current, 'claude')).toEqual(current);
  });

  it('preselects the new core\'s last used model when one is still cataloged', () => {
    const { apCoreSelection } = load() as {
      apCoreSelection: (
        current: { core: string; model: string; effort: string },
        core: string,
        recentIds?: string[],
        catalog?: unknown,
      ) => { core: string; model: string; effort: string };
    };

    expect(apCoreSelection(
      { core: 'claude', model: 'claude-opus-5', effort: 'high' },
      'codex',
      ['gpt-5.6-sol'],
      catalog,
    )).toEqual({ core: 'codex', model: 'gpt-5.6-sol', effort: '' });
  });

  it('leaves the model unset when the new core\'s last used model left the catalog', () => {
    const { apCoreSelection } = load() as {
      apCoreSelection: (
        current: { core: string; model: string; effort: string },
        core: string,
        recentIds?: string[],
        catalog?: unknown,
      ) => { core: string; model: string; effort: string };
    };

    expect(apCoreSelection(
      { core: 'claude', model: 'claude-opus-5', effort: 'high' },
      'codex',
      ['ghost-model'],
      catalog,
    )).toEqual({ core: 'codex', model: '', effort: '' });
  });

  describe('apInheritLabels', () => {
    const { apInheritLabels } = load() as {
      apInheritLabels: (
        inherit: { core?: string; model?: string; effort?: string },
        inheritCore: string,
        core: string,
      ) => { core: string; model: string; effort: string };
    };
    const inherit = {
      core: 'Inherit (settings: Claude Code)',
      model: 'Inherit (settings: Opus 5)',
      effort: 'Inherit (settings: high)',
    };

    it('keeps the model/effort inherit labels when the selected core IS the inherited one', () => {
      expect(apInheritLabels(inherit, 'claude', 'claude')).toEqual(inherit);
    });

    it('drops the model/effort inherit labels for a different core', () => {
      expect(apInheritLabels(inherit, 'claude', 'opencode')).toEqual({
        core: inherit.core,
        model: '',
        effort: '',
      });
    });

    it('keeps them when no inherited core is known (host declares none)', () => {
      expect(apInheritLabels(inherit, '', 'opencode')).toEqual(inherit);
    });

    it('keeps them while the core itself is inherited (no explicit pick)', () => {
      expect(apInheritLabels(inherit, 'claude', '')).toEqual(inherit);
    });
  });

  describe('apEfforts', () => {
    const { apEfforts } = load() as { apEfforts: (c: unknown, p: string, m: string) => string[] | undefined };

    it('returns the advertised efforts of a cataloged model', () => {
      expect(apEfforts(catalog, 'claude', 'claude-opus-5')).toEqual(['low', 'medium', 'high', 'max']);
    });

    it('returns undefined for a model whose entry advertises none', () => {
      expect(apEfforts(catalog, 'antigravity', 'gemini-3.6-flash-high')).toBeUndefined();
    });

    it('returns undefined for an unknown model id or a blank model', () => {
      expect(apEfforts(catalog, 'claude', 'my-custom')).toBeUndefined();
      expect(apEfforts(catalog, 'claude', '')).toBeUndefined();
      expect(apEfforts(catalog, 'claude', null as unknown as string)).toBeUndefined();
    });
  });

  describe('apTags', () => {
    const { apTags } = load() as { apTags: (c: unknown, p: string, m: string) => string[] | undefined };

    it('returns the advertised capability tags of a cataloged model', () => {
      expect(apTags(catalog, 'claude', 'claude-opus-5')).toEqual(['multimodal', 'vision']);
    });

    it('returns undefined for a model whose entry advertises none', () => {
      expect(apTags(catalog, 'antigravity', 'gemini-3.6-flash-high')).toBeUndefined();
    });

    it('returns undefined for an unknown model id or a blank model', () => {
      expect(apTags(catalog, 'claude', 'my-custom')).toBeUndefined();
      expect(apTags(catalog, 'claude', '')).toBeUndefined();
      expect(apTags(catalog, 'claude', null as unknown as string)).toBeUndefined();
    });
  });

  describe('apModelTagsHtml', () => {
    const { apModelTagsHtml } = load() as { apModelTagsHtml: (tags: string[] | undefined) => string };

    it('renders a chip per tag', () => {
      const out = apModelTagsHtml(['multimodal', 'vision']);
      expect(out).toContain('class="ap-tag"');
      expect(out).toContain('>multimodal<');
      expect(out).toContain('>vision<');
    });

    it('returns empty for undefined, empty, or null input', () => {
      expect(apModelTagsHtml(undefined)).toBe('');
      expect(apModelTagsHtml([])).toBe('');
      expect(apModelTagsHtml(null as unknown as string[])).toBe('');
    });

    it('escapes a hostile tag so it cannot inject markup', () => {
      const out = apModelTagsHtml(['<img onerror=alert(1)>']);
      expect(out).not.toContain('<img');
    });
  });

  describe('apEffortOptions', () => {
    const { apEffortOptions } = load() as {
      apEffortOptions: (c: unknown, p: string, m: string, saved: string, label?: string) => { html: string; efforts: string[] | null; savedVisible: string };
    };

    it('renders the inherit/none row plus every advertised effort, none selected', () => {
      const out = apEffortOptions(catalog, 'claude', 'claude-sonnet-5', '', 'Inherit (settings: medium)');
      expect(out.html).toContain('<option value="" selected>Inherit (settings: medium)</option>');
      for (const v of ['low', 'medium', 'high']) expect(out.html).toContain(`<option value="${v}">${v}</option>`);
      expect(out.html).not.toContain('selected>low');
      expect(out.efforts).toEqual(['low', 'medium', 'high']);
    });

    it('marks the saved effort selected', () => {
      const out = apEffortOptions(catalog, 'claude', 'claude-opus-5', 'high');
      expect(out.html).toContain('<option value="high" selected>high</option>');
      expect(out.html).toContain('value="">No effort (agent picks)</option>');
    });

    it('keeps a saved effort that left the catalog as a visible Saved row', () => {
      const out = apEffortOptions(catalog, 'claude', 'claude-sonnet-5', 'ultracode');
      expect(out.html).toContain('Saved: ultracode');
    });

    it('returns no options when the model advertises no efforts', () => {
      const out = apEffortOptions(catalog, 'antigravity', 'gemini-3.6-flash-high', '');
      expect(out.html).toBe('');
      expect(out.efforts).toBeNull();
    });

    it('escapes the inherit label so it cannot inject markup', () => {
      const out = apEffortOptions(catalog, 'claude', 'claude-sonnet-5', '', '<img onerror=alert(1)>');
      expect(out.html).not.toContain('<img');
    });
  });

  describe('apCoreOptionsHtml', () => {
    const { apCoreOptionsHtml } = load() as {
      apCoreOptionsHtml: (cores: { id: string; label: string }[], current: string, inheritLabel: string) => string;
    };
    const cores = [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ];

    it('renders the inherit row first when labeled', () => {
      const out = apCoreOptionsHtml(cores, 'claude', 'Inherit (settings: Claude Code)');
      expect(out).toContain('Inherit (settings: Claude Code)');
      expect(out.indexOf('data-ap-core=""')).toBeLessThan(out.indexOf('data-ap-core="claude"'));
    });

    it('marks the current core active and selected', () => {
      const out = apCoreOptionsHtml(cores, 'codex', '');
      expect(out).toContain('data-ap-core="codex" aria-selected="true"');
      expect(out).toContain('data-ap-core="claude" aria-selected="false"');
    });

    it('omits the inherit row when no label is given', () => {
      const out = apCoreOptionsHtml(cores, '', '');
      expect(out).not.toContain('data-ap-core=""');
      expect(out).toContain('data-ap-core="claude"');
    });
  });

  describe('apModelOptionsHtml', () => {
    const { apModelOptionsHtml } = load() as {
      apModelOptionsHtml: (c: unknown, p: string, saved: string, inheritLabel: string, recentIds?: string[]) => string;
    };

    it('renders the inherit row first when labeled, then the cataloged models', () => {
      const out = apModelOptionsHtml(catalog, 'claude', 'claude-sonnet-5', 'Inherit (settings: Sonnet 5)');
      expect(out).toContain('Inherit (settings: Sonnet 5)');
      expect(out).toContain('data-ap-model="claude-sonnet-5" aria-selected="true"');
      expect(out).toContain('data-ap-model="claude-opus-5" aria-selected="false"');
    });

    it('shows an empty note for a core with no cataloged models', () => {
      const out = apModelOptionsHtml(catalog, 'opencode', '', '');
      expect(out).toContain('No models listed for this core.');
    });

    it('keeps a saved model that left the catalog visible as unavailable', () => {
      const out = apModelOptionsHtml(catalog, 'claude', 'my-custom-model', '');
      expect(out).toContain('Saved model (unavailable)');
      expect(out).toContain('data-ap-model="my-custom-model"');
    });

    it('escapes a saved model id so it cannot inject markup', () => {
      const out = apModelOptionsHtml(catalog, 'claude', '<img onerror=alert(1)>', '');
      expect(out).not.toContain('<img');
    });

    it('pins the last-used models under a group label, before the full list', () => {
      const withMore = {
        claude: [
          ...(catalog.claude as { id: string; label: string; efforts: string[] }[]),
          { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
        ],
      };
      const out = apModelOptionsHtml(
        withMore,
        'claude',
        '',
        '',
        ['claude-sonnet-5', 'claude-opus-5'],
      );
      const lastUsed = out.indexOf('Last used');
      const sonnet = out.indexOf('data-ap-model="claude-sonnet-5"');
      const opus = out.indexOf('data-ap-model="claude-opus-5"');
      expect(lastUsed).toBeGreaterThan(-1);
      expect(sonnet).toBeGreaterThan(-1);
      expect(opus).toBeGreaterThan(-1);
      expect(lastUsed).toBeLessThan(sonnet);
      expect(sonnet).toBeLessThan(opus);
    });

    it('keeps last-used order as given (newest first) and drops catalog-absent ids', () => {
      const out = apModelOptionsHtml(catalog, 'claude', '', '', ['ghost-model', 'claude-opus-5']);
      expect(out).not.toContain('ghost-model');
      expect(out.indexOf('data-ap-model="claude-opus-5"')).toBeLessThan(out.indexOf('data-ap-model="claude-sonnet-5"'));
    });

    it('caps the last-used group at five and dedupes repeated ids', () => {
      const manyModels = {
        claude: Array.from({ length: 8 }, (_, i) => ({
          id: `m-${i}`,
          label: `Model ${i}`,
          efforts: [],
        })),
      };
      const recent = ['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7', 'm-0'];
      const out = apModelOptionsHtml(manyModels, 'claude', '', '', recent);
      // Group header once; the five NEWEST recent models come first, in the
      // given order, before the remaining catalog models (which still render).
      expect(out.split('Last used')).toHaveLength(2);
      const ids = [...out.matchAll(/data-ap-model="(m-\d)"/g)].map((m) => m[1]);
      expect(ids.slice(0, 5)).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);
      expect(ids.slice(5)).toEqual(['m-5', 'm-6', 'm-7']);
    });

    it('omits the group header when the recent set covers the whole catalog', () => {
      const out = apModelOptionsHtml(catalog, 'codex', '', '', ['gpt-5.6-sol']);
      expect(out).not.toContain('Last used');
      expect(out).toContain('data-ap-model="gpt-5.6-sol"');
    });

    it('marks a recently used model that is the current selection as saved', () => {
      const out = apModelOptionsHtml(catalog, 'claude', 'claude-sonnet-5', '', ['claude-sonnet-5']);
      expect(out).toContain('data-ap-model="claude-sonnet-5" aria-selected="true"');
      expect(out).toContain('saved');
    });

    it('renders a model with tags as chips in its row', () => {
      const out = apModelOptionsHtml(catalog, 'claude', 'claude-opus-5', '');
      expect(out).toContain('class="ap-tag"');
      expect(out).toContain('>multimodal<');
      expect(out).toContain('>vision<');
    });

    it('renders no tag-chip block for a model that advertises none', () => {
      const out = apModelOptionsHtml(catalog, 'antigravity', 'gemini-3.6-flash-high', '');
      expect(out).not.toContain('ap-model-tags');
    });

    it('renders tags in the last-used group rows too', () => {
      const out = apModelOptionsHtml(catalog, 'claude', '', '', ['claude-sonnet-5']);
      expect(out).toContain('Last used');
      expect(out.indexOf('class="ap-tag"')).toBeGreaterThan(out.indexOf('Last used'));
      expect(out).toContain('>text-only<');
    });
  });
});

describe('apParseModelId', () => {
  const { apParseModelId } = load() as {
    apParseModelId: (id: string, label?: string) => {
      id: string; route: string; vendor: string; model: string; free: boolean; variant: string;
    };
  };

  it('leaves an id with no slash unrouted, exactly as today', () => {
    expect(apParseModelId('claude-opus-5', 'Opus 5')).toEqual({
      id: 'claude-opus-5', route: '', vendor: '', model: 'Opus 5', free: false, variant: '',
    });
  });

  it('splits a two-segment id into route and model', () => {
    expect(apParseModelId('opencode/big-pickle', 'big-pickle')).toEqual({
      id: 'opencode/big-pickle', route: 'opencode', vendor: '', model: 'big-pickle', free: false, variant: '',
    });
  });

  it('keeps the middle segment as the vendor', () => {
    expect(apParseModelId('openrouter/mancer/weaver', 'weaver')).toEqual({
      id: 'openrouter/mancer/weaver', route: 'openrouter', vendor: 'mancer', model: 'weaver', free: false, variant: '',
    });
  });

  it('joins a multi-segment vendor path', () => {
    expect(apParseModelId('openrouter/inference-net/schematron-v2-turbo', '').vendor)
      .toBe('inference-net');
    expect(apParseModelId('openrouter/a/b/c/model', '').vendor).toBe('a/b/c');
    expect(apParseModelId('openrouter/a/b/c/model', '').model).toBe('model');
  });

  it('reads :free as the free flag, not as part of the name', () => {
    const p = apParseModelId('openrouter/liquid/lfm-2.5-2.6b:free', '');
    expect(p.model).toBe('lfm-2.5-2.6b');
    expect(p.free).toBe(true);
    expect(p.variant).toBe('');
  });

  it('reads a -free suffix as the free flag', () => {
    const p = apParseModelId('opencode/big-pickle-free', '');
    expect(p.free).toBe(true);
    expect(p.model).toBe('big-pickle-free');
  });

  it('reads #high as the variant', () => {
    const p = apParseModelId('opencode-go/space-bunny#high', '');
    expect(p.route).toBe('opencode-go');
    expect(p.model).toBe('space-bunny');
    expect(p.variant).toBe('high');
    expect(p.free).toBe(false);
  });

  it('reads a non-free colon suffix as the variant', () => {
    const p = apParseModelId('openrouter/x/y:nitro', '');
    expect(p.model).toBe('y');
    expect(p.variant).toBe('nitro');
    expect(p.free).toBe(false);
  });

  it('tolerates empty segments', () => {
    expect(apParseModelId('a//b', '')).toEqual({
      id: 'a//b', route: 'a', vendor: '', model: 'b', free: false, variant: '',
    });
  });

  it('lets a curated label that differs from the id win as the model name', () => {
    expect(apParseModelId('opencode-go/deepseek-v4.1-flash', 'DeepSeek v4.1 Flash').model)
      .toBe('DeepSeek v4.1 Flash');
    expect(apParseModelId('opencode-go/deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash').model)
      .toBe('deepseek-v4.1-flash');
  });

  it('handles empty input without throwing', () => {
    expect(apParseModelId('', '')).toEqual({
      id: '', route: '', vendor: '', model: '', free: false, variant: '',
    });
  });
});

describe('the picker carries the route map', () => {
  it('defines AP_ROUTES inside the emitted picker runtime', () => {
    expect(js).toContain('var AP_ROUTES = ');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const map = new Function(`${js}\nreturn AP_ROUTES;`)() as Record<string, { name: string }>;
    expect(map.openrouter?.name).toBe('OpenRouter');
  });
});

describe('route identity in the closed control', () => {
  const fns = load() as {
    apParseModelId: (id: string, label?: string) => unknown;
    apRouteIconHtml: (route: string, routes?: unknown) => string;
    apRoutedTriggerName: (caption: string, parsed: unknown, routes?: unknown) => string;
    apRouteHue: (route: string) => number;
  };
  const routes = {
    openrouter: { name: 'OpenRouter', badge: '', iconSvg: '<svg id="or"></svg>' },
    opencode: { name: 'OpenCode Zen', badge: 'Z', iconSvg: '<svg id="oc"></svg>' },
    unknown: { name: '', badge: '', iconSvg: '' },
  };

  it('renders the host icon and badge for a known route', () => {
    const out = fns.apRouteIconHtml('opencode', routes);
    expect(out).toContain('class="ap-route"');
    expect(out).toContain('title="OpenCode Zen"');
    expect(out).toContain('<svg id="oc"></svg>');
    expect(out).toContain('class="ap-route-badge">Z<');
    expect(out).toContain('aria-hidden="true"');
  });

  it('falls back to a letter monogram with a derived hue for an unknown route', () => {
    const out = fns.apRouteIconHtml('weaver-net', routes);
    expect(out).toContain('class="ap-mono"');
    expect(out).toContain('>W<');
    expect(out).toMatch(/style="--ap-hue:\d+"/);
    expect(out).toContain('title="weaver-net"');
    expect(out).not.toContain('ap-route-badge');
  });

  it('renders no mark at all for an empty route', () => {
    expect(fns.apRouteIconHtml('', routes)).toBe('');
  });

  it('derives a stable hue per route id', () => {
    expect(fns.apRouteHue('openrouter')).toBe(fns.apRouteHue('openrouter'));
    expect(fns.apRouteHue('openrouter')).toBeGreaterThanOrEqual(0);
    expect(fns.apRouteHue('openrouter')).toBeLessThan(360);
  });

  it('names the trigger with the model, the vendor, the route and the full id', () => {
    expect(fns.apRoutedTriggerName('Model', fns.apParseModelId('openrouter/mancer/weaver', 'weaver'), routes))
      .toBe('Model: weaver, mancer via OpenRouter \u2014 openrouter/mancer/weaver');
  });

  it('names a two-segment route without a vendor, and appends free', () => {
    expect(fns.apRoutedTriggerName('Model', fns.apParseModelId('opencode/big-pickle', 'big-pickle'), routes))
      .toBe('Model: big-pickle via OpenCode Zen \u2014 opencode/big-pickle');
    expect(fns.apRoutedTriggerName('Model', fns.apParseModelId('openrouter/x/y:free', ''), routes))
      .toContain(', free');
  });

  it('ships the two-line stack, the never-shrinking free tag and the container query', () => {
    expect(js).toContain('ap-mstack');
    expect(js).toContain('ap-mvendor');
    expect(js).toContain('ap-mname');
    const css = agentPickerCss();
    expect(css).toContain('.ap-mstack{display:flex;flex-direction:column');
    expect(css).toMatch(/\.ap-mname,\.ap-mvendor\{[^}]*text-overflow:ellipsis/);
    expect(css).toMatch(/\.ap-free\{[^}]*flex:none/);
    // The stacked trigger keeps the one shared control height (D108 alignment).
    expect(css).toMatch(/\.ap-trigger:has\(\.ap-mstack\)\{[^}]*padding-top:var\(--k-space-1\)/);
    expect(css).toContain('.ap-shell[data-ap-shell="model"]{container-type:inline-size}');
    expect(css).toContain('@container (max-width: 130px){.ap-free{display:none}}');
  });

  it('clips only with a described trigger name (UI-R44)', () => {
    const stack = new Function(`${js}\nreturn apModelStackHtml;`)() as (
      parsed: unknown,
      triggerId: string,
    ) => string;
    const out = stack(fns.apParseModelId('openrouter/mancer/weaver#high', 'weaver'), 'ap-7-model');
    expect(out).toContain('aria-describedby="ap-7-model"');
    expect(out).toContain('<span class="ap-variant">');
  });
});

describe('route → vendor grouping and the full-id footer', () => {
  const fns = load() as {
    apModelOptionsHtml: (
      c: unknown, p: string, saved: string, inherit: string,
      recent?: string[], routes?: unknown, query?: string,
    ) => string;
  };
  const routes = {
    opencode: { name: 'OpenCode Zen', badge: 'Z', iconSvg: '' },
    'opencode-go': { name: 'OpenCode Go', badge: 'Go', iconSvg: '' },
    openrouter: { name: 'OpenRouter', badge: '', iconSvg: '' },
  };
  const mixed = {
    opencode2: [
      { id: 'opencode/big-pickle-free', label: 'big-pickle-free' },
      { id: 'opencode-go/space-bunny#high', label: 'Space Bunny', efforts: ['high'] },
      { id: 'openrouter/mancer/weaver', label: 'weaver' },
      { id: 'openrouter/liquid/lfm-2.5-2.6b:free', label: 'LFM 2.5 2.6B' },
    ],
  };

  it('heads each route group with its icon and name, then each vendor', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes);
    const zen = out.indexOf('OpenCode Zen');
    const go = out.indexOf('OpenCode Go');
    const or = out.indexOf('OpenRouter');
    expect(zen).toBeGreaterThan(-1);
    expect(zen).toBeLessThan(go);
    expect(go).toBeLessThan(or);
    expect(out).toContain('class="ap-group-sub" role="presentation">mancer<');
    expect(out).toContain('class="ap-group-sub" role="presentation">liquid<');
    expect(out).toContain('class="ap-route"');
  });

  it('adds no route heading when every model is unrouted', () => {
    const out = fns.apModelOptionsHtml(catalog, 'claude', '', '');
    expect(out).not.toContain('ap-group-label');
  });

  it('omits a route group whose every row is already in the last-used group', () => {
    const twoRoutes = {
      opencode2: [
        { id: 'opencode-go/space-bunny', label: 'Space Bunny' },
        { id: 'openrouter/mancer/weaver', label: 'weaver' },
      ],
    };
    const out = fns.apModelOptionsHtml(twoRoutes, 'opencode2', '', '', ['opencode-go/space-bunny'], routes);
    // Its only row is shown under "Last used", so the heading would hang over nothing.
    expect(out).toContain('Last used');
    expect(out).not.toContain('<span>OpenCode Go</span>');
    expect(out).toContain('<span>OpenRouter</span>');
    expect(out).toContain('data-ap-model="openrouter/mancer/weaver"');
  });

  it('keeps a route heading when that route still has a row left', () => {
    const twoRoutes = {
      opencode2: [
        { id: 'opencode-go/space-bunny', label: 'Space Bunny' },
        { id: 'opencode-go/mimo-v2.5', label: 'MiMo v2.5' },
      ],
    };
    const out = fns.apModelOptionsHtml(twoRoutes, 'opencode2', '', '', ['opencode-go/space-bunny'], routes);
    expect(out).toContain('<span>OpenCode Go</span>');
    expect(out).toContain('data-ap-model="opencode-go/mimo-v2.5"');
  });

  it('drops a curated label prefix that repeats the route heading', () => {
    const labelled = {
      opencode2: [{ id: 'opencode-go/mimo-v2.5', label: 'OpenCode Go \u00b7 MiMo v2.5' }],
    };
    const out = fns.apModelOptionsHtml(labelled, 'opencode2', '', '', undefined, routes);
    expect(out).toContain('>MiMo v2.5<');
    expect(out).not.toContain('OpenCode Go \u00b7 MiMo v2.5');
  });

  it('keeps a label that does not repeat the route, and a raw id unchanged', () => {
    const curated = {
      opencode2: [
        { id: 'opencode-go/space-bunny', label: 'Space Bunny' },
        { id: 'openrouter/mancer/weaver', label: 'openrouter/mancer/weaver' },
      ],
    };
    const out = fns.apModelOptionsHtml(curated, 'opencode2', '', '', undefined, routes);
    expect(out).toContain('>Space Bunny<');
    expect(out).toContain('>weaver<');
  });

  it('drops the duplicate full-id line and puts it in the row title instead', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes);
    expect(out).not.toContain('ap-model-sub');
    expect(out).toContain('title="openrouter/mancer/weaver"');
    expect(out).toContain('data-ap-full="openrouter/mancer/weaver"');
  });

  it('shows the variant and the free tag on the row', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes);
    expect(out).toContain('<span class="ap-variant"> high</span>');
    expect(out).toContain('<span class="ap-free">free</span>');
  });

  it('filters on the model name, the vendor, the route id, the route name and the full id', () => {
    const byVendor = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'mancer');
    expect(byVendor).toContain('data-ap-model="openrouter/mancer/weaver"');
    expect(byVendor).not.toContain('space-bunny');
    const byRouteName = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'opencode go');
    expect(byRouteName).toContain('data-ap-model="opencode-go/space-bunny#high"');
    expect(byRouteName).not.toContain('weaver');
    const byFullId = fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'liquid/lfm');
    expect(byFullId).toContain('data-ap-model="openrouter/liquid/lfm-2.5-2.6b:free"');
  });

  it('reports no match for a filter that hits nothing', () => {
    expect(fns.apModelOptionsHtml(mixed, 'opencode2', '', '', undefined, routes, 'zzz'))
      .toContain('No models match "zzz".');
  });

  it('keeps the saved-unavailable row reachable with its full id', () => {
    const out = fns.apModelOptionsHtml(mixed, 'opencode2', 'gone/model', '', undefined, routes);
    expect(out).toContain('Saved model (unavailable)');
    expect(out).toContain('data-ap-full="gone/model"');
  });

  it('marks exactly one row active — re-opening cannot leave two highlighted', () => {
    const marks = [
      { active: false, classList: { toggle(name: string, on: boolean) { if (name === 'active') this.on = on; }, on: false } },
      { active: false, classList: { toggle(name: string, on: boolean) { if (name === 'active') this.on = on; }, on: false } },
      { active: false, classList: { toggle(name: string, on: boolean) { if (name === 'active') this.on = on; }, on: false } },
    ];
    const { apMarkActive } = load() as { apMarkActive: (items: unknown[], index: number) => void };
    apMarkActive(marks, 1);
    expect(marks.map((m) => m.classList.on)).toEqual([false, true, false]);
    apMarkActive(marks, 2);
    expect(marks.map((m) => m.classList.on)).toEqual([false, false, true]);
    apMarkActive(marks, -1);
    expect(marks.map((m) => m.classList.on)).toEqual([false, false, false]);
  });

  it('ships the footer, arrow-key, Enter and focus-on-open wiring', () => {
    expect(js).toContain('data-ap-foot');
    expect(js).toContain('aria-live="polite"');
    expect(js).toContain('function moveActive(');
    expect(js).toContain('function syncMenuFoot(');
    expect(js).toContain("'ArrowDown'");
    expect(js).toContain("'Enter'");
    expect(js).toContain('data-ap-search]');
    expect(js).toContain('.focus()');
  });

  it('pins the footer and sub-heading styles with tokens', () => {
    const css = agentPickerCss();
    expect(css).toMatch(/\.ap-group-sub\{[^}]*color:var\(--k-text-faint\)/);
    expect(css).toMatch(/\.ap-menu-foot\{[^}]*border-top:var\(--k-border-w\) solid var\(--k-border\)/);
    // The footer wraps rather than ellipsizing: the full id must be readable
    // (UI-R44), and a clipped footer would be flagged as clipped text.
    expect(css).toMatch(/\.ap-menu-foot\{[^}]*overflow-wrap:anywhere/);
    expect(css).not.toMatch(/\.ap-menu-foot\{[^}]*text-overflow/);
  });
});

describe('agentPickerCss', () => {  it('defines the picker primitives with token-only values', () => {
    const css = agentPickerCss();
    expect(css).toContain('.ap{');
    expect(css).toContain('.ap-trigger{');
    expect(css).toContain('.ap-menu{');
    expect(css).toContain('.ap-opt{');
    expect(css).toContain('.ap-model-item{');
    expect(css).toContain('.ap-effort{');
  });
});

describe('injectAgentPicker', () => {
  it('replaces both markers with their emitted blocks', () => {
    const html = `<style>${AGENT_PICKER_CSS_MARKER}</style><script>${AGENT_PICKER_JS_MARKER}\nconst x=1;</script>`;
    const out = injectAgentPicker(html);
    expect(out).not.toContain(AGENT_PICKER_CSS_MARKER);
    expect(out).not.toContain(AGENT_PICKER_JS_MARKER);
    expect(out).toContain('.ap{');
    expect(out).toContain('function mountAgentPicker(');
  });

  it('is a no-op when a marker is absent', () => {
    expect(injectAgentPicker('<div>no marker</div>')).toBe('<div>no marker</div>');
  });

  it('escaped marker in a template literal does not collide', () => {
    const html = `<style>/*KARST_AGENT_PICKER_CSS*/</style>`;
    const out = injectAgentPicker(html);
    expect(out).not.toContain(AGENT_PICKER_CSS_MARKER);
  });
});

describe('compact effort placeholder', () => {
  const fns = load() as {
    apEffortMode: (e: string[] | undefined, saved: string, compact: boolean) => string;
    apModelTriggerName: (label: string, id: string, fallback: string) => string;
  };
  it('offers a select when the model advertises efforts', () => {
    expect(fns.apEffortMode(['low', 'high'], '', true)).toBe('select');
    expect(fns.apEffortMode(['low', 'high'], '', false)).toBe('select');
  });
  it('keeps a saved effort visible as a select', () => {
    expect(fns.apEffortMode(undefined, 'high', true)).toBe('select');
  });
  it('shows a disabled placeholder only in compact mode', () => {
    expect(fns.apEffortMode(undefined, '', true)).toBe('placeholder');
    expect(fns.apEffortMode([], '', true)).toBe('placeholder');
  });
  it('hides Effort outside compact mode as today', () => {
    expect(fns.apEffortMode(undefined, '', false)).toBe('hidden');
  });
  it('puts the full model id in the trigger name', () => {
    expect(fns.apModelTriggerName('deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash', 'No model'))
      .toBe('deepseek-v4.1-flash \u2014 opencode-go/deepseek-v4.1-flash');
    expect(fns.apModelTriggerName('', '', 'No model')).toBe('No model');
    expect(fns.apModelTriggerName('same', 'same', 'x')).toBe('same');
  });
  it('ships the disabled select placeholder and its CSS', () => {
    expect(js).toContain('ap-effort--na');
    expect(js).toContain('\\u2014');
    expect(js).toContain(': not available for this model');
    expect(js).not.toContain('data-ap-effort-placeholder');
    expect(agentPickerCss()).toContain('.ap-effort--na');
    expect(agentPickerCss()).toMatch(/\.ap-effort--na\{[^}]*color:var\(--k-text-dim\)[^}]*dashed/);
  });
  it('pins the compact Core | Model | Effort template', () => {
    expect(agentPickerCss()).toContain(
      '.ap-compact{grid-template-columns:minmax(0,1.3fr) minmax(0,1.6fr) minmax(96px,0.8fr)',
    );
  });
});

describe('truncated trigger text stays reachable (UI-R44)', () => {
  const fns = load() as {
    apTriggerLabelHtml?: (inner: string, triggerId: string) => string;
    apCoreTriggerName?: (caption: string, coreName: string) => string;
  };
  it('describes the clipping label by its trigger, whose name carries the full text', () => {
    expect(fns.apTriggerLabelHtml!('Claude Code', 'ap-3-core'))
      .toBe('<span class="ap-trigger-label" aria-describedby="ap-3-core">Claude Code</span>');
  });
  it('names the compact core trigger with the full core label', () => {
    expect(fns.apCoreTriggerName!('Core', 'Claude Code')).toBe('Core: Claude Code');
    expect(fns.apCoreTriggerName!('Core', '')).toBe('Core');
  });
  it('compact fields are not table cells (the row owns the picker cell now)', () => {
    expect(js).not.toContain('role="cell"');
  });
  it('gives each trigger a unique id and wires the labels to it', () => {
    expect(js).toContain("id=\"' + apId + '-core\"");
    expect(js).toContain("id=\"' + apId + '-model\"");
    expect(js).toContain("apTriggerLabelHtml(");
  });
});
