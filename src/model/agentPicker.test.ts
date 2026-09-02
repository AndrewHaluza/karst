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
    apTags, apModelTagsHtml,
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

describe('agentPickerCss', () => {
  it('defines the picker primitives with token-only values', () => {
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
