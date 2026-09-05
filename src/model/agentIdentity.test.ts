import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_LABELS,
  AGENT_ICONS,
  agentIconSvg,
  AGENT_CSS_MARKER,
  AGENT_JS_MARKER,
  agentIdentityCss,
  agentIdentityJs,
  injectAgentIdentity,
  AGENT_ICONS_DIR,
} from './agentIdentity.js';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(HERE, 'icons', 'agent');

describe('AGENT_PROVIDERS registry', () => {
  it('registers the four canonical providers with their canonical names', () => {
    expect(Object.keys(AGENT_PROVIDERS).sort()).toEqual(['antigravity', 'claude', 'codex', 'opencode']);
    expect(AGENT_PROVIDERS.claude.label).toBe('Claude Code');
    expect(AGENT_PROVIDERS.codex.label).toBe('Codex');
    expect(AGENT_PROVIDERS.antigravity.label).toBe('Antigravity CLI');
    expect(AGENT_PROVIDERS.opencode.label).toBe('OpenCode');
  });

  it('every registered icon asset exists in the asset dir', () => {
    for (const meta of Object.values(AGENT_PROVIDERS)) {
      expect(existsSync(join(ICONS_DIR, meta.icon)), meta.icon).toBe(true);
    }
  });

  it('every icon is monochrome — a currentColor fill and no baked-in color machinery', () => {
    for (const [provider, meta] of Object.entries(AGENT_PROVIDERS)) {
      const raw = readFileSync(join(ICONS_DIR, meta.icon), 'utf8');
      expect(raw, provider).toMatch(/fill="currentColor"/);
      expect(raw, provider).not.toMatch(/fill="#/);
      expect(raw, provider).not.toMatch(/<(mask|filter|linearGradient|radialGradient)/i);
    }
  });

  it('derives the label map from the registry — one source of truth', () => {
    expect(AGENT_PROVIDER_LABELS).toEqual(
      Object.fromEntries(Object.entries(AGENT_PROVIDERS).map(([p, m]) => [p, m.label])),
    );
  });

  it('loads a normalized inline SVG for every provider', () => {
    for (const provider of Object.keys(AGENT_PROVIDERS)) {
      const svg = agentIconSvg(provider);
      expect(svg.startsWith('<svg'), provider).toBe(true);
      expect(svg.endsWith('</svg>'), provider).toBe(true);
    }
  });

  it('strips the em-based size so CSS alone controls icon size', () => {
    const svg = agentIconSvg('claude');
    expect(svg).not.toMatch(/width="1em"/);
    expect(svg).not.toMatch(/height="1em"/);
    expect(svg).not.toContain('style=');
    expect(svg).not.toContain('<title>');
  });

  it('renders an unknown provider without an icon', () => {
    expect(agentIconSvg('gemini')).toBe('');
    expect(AGENT_ICONS).not.toHaveProperty('gemini');
  });
});

describe('agentIdentityCss', () => {
  it('defines the badge rules AND the identity component with separated name/model', () => {
    const css = agentIdentityCss();
    expect(css).toContain('.agentbadge{');
    expect(css).toContain('.agenticon{');
    expect(css).toContain('.agenticon svg{');
    expect(css).toContain('.agent-identity{');
    expect(css).toContain('.agent-identity-icon{');
    expect(css).toContain('.agent-identity-name{');
    expect(css).toContain('.agent-identity-model{');
  });

  it('ships a compact variant that shrinks the mark, not the text run', () => {
    const css = agentIdentityCss();
    expect(css).toContain('.agent-identity.compact{');
    expect(css).toMatch(/\.agent-identity\.compact \.agent-identity-icon\{[^}]*width:12px/);
  });
});

describe('agentIdentityJs', () => {
  const js = agentIdentityJs();

  it('embeds the registry with icons, the label map, and the icon map', () => {
    expect(js).toContain('AGENT_PROVIDERS');
    expect(js).toContain('Antigravity CLI');
    expect(js).toContain('AGENT_PROVIDER_LABELS');
    expect(js).toContain('AGENT_ICONS');
  });

  it('defines the badge, icon and identity component functions', () => {
    expect(js).toContain('function agentBadgeHtml(provider)');
    expect(js).toContain('function agentIconHtml(provider)');
    expect(js).toContain('function agentIdentityHtml(provider, model, compact)');
  });

  describe('agentBadgeHtml', () => {
    const load = () => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function(`${js}\nreturn agentBadgeHtml;`)() as (p: string | null) => string;
    };

    it('renders icon + canonical name for a registered provider', () => {
      const out = load()('claude');
      expect(out).toContain('agentbadge');
      expect(out).toContain('<svg');
      expect(out).toContain('Claude Code');
    });

    it('falls back to a title-cased raw id for an unknown provider, no icon', () => {
      const out = load()('gemini');
      expect(out).toContain('Gemini');
      expect(out).not.toContain('<svg');
    });

    it('escapes an unknown provider id so it cannot inject markup', () => {
      const out = load()('<img onerror=alert(1)>');
      expect(out).not.toContain('<img');
    });

    it('renders a badge for the empty default choice', () => {
      expect(load()('')).toContain('agentbadge');
    });
  });

  describe('agentIdentityHtml — the reusable component', () => {
    const load = () => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function(`${js}\nreturn agentIdentityHtml;`)() as (
        p: string | null,
        model?: string | null,
        compact?: boolean,
      ) => string;
    };

    it('renders [icon] Provider · Model with the identities in separate elements', () => {
      const out = load()('claude', 'Opus 4.1');
      expect(out).toContain('<span class="agent-identity"');
      expect(out).toContain('<span class="agent-identity-icon"');
      expect(out).toContain('<span class="agent-identity-name">Claude Code</span>');
      expect(out).toContain('<span class="agent-identity-sep"');
      expect(out).toContain('<span class="agent-identity-model">Opus 4.1</span>');
    });

    it('omits the separator and model when no model is known', () => {
      const out = load()('codex', null);
      expect(out).not.toContain('agent-identity-sep');
      expect(out).not.toContain('agent-identity-model');
      expect(out).toContain('Codex');
    });

    it('adds the compact class for the terminal-friendly variant', () => {
      expect(load()('opencode', 'DeepSeek V4', true)).toContain('agent-identity compact');
      expect(load()('opencode', 'DeepSeek V4')).not.toContain('compact');
    });

    it('carries the semantic provider id as data for styling hooks', () => {
      expect(load()('codex', 'GPT-5')).toContain('data-provider="codex"');
    });

    it('escapes the model label so it cannot inject markup', () => {
      const out = load()('claude', '<img onerror=alert(1)>');
      expect(out).not.toContain('<img');
    });

    it('degrades to the title-cased id for an unknown provider', () => {
      const out = load()('gemini', null);
      expect(out).toContain('Gemini');
      expect(out).not.toContain('<svg');
    });
  });
});

describe('injectAgentIdentity', () => {
  it('replaces both markers with their emitted blocks', () => {
    const html = `<style>${AGENT_CSS_MARKER}</style><script>${AGENT_JS_MARKER}\nconst x=1;</script>`;
    const out = injectAgentIdentity(html);
    expect(out).not.toContain(AGENT_CSS_MARKER);
    expect(out).not.toContain(AGENT_JS_MARKER);
    expect(out).toContain('.agentbadge{');
    expect(out).toContain('function agentIdentityHtml');
  });

  it('is a no-op when a marker is absent', () => {
    expect(injectAgentIdentity('<div>no marker</div>')).toBe('<div>no marker</div>');
  });
});

describe('asset bytes (canonical sources)', () => {
  it('the injected icon for each provider equals the normalized asset file', () => {
    for (const [provider, meta] of Object.entries(AGENT_PROVIDERS)) {
      const raw = readFileSync(join(ICONS_DIR, meta.icon), 'utf8');
      const normalized = raw
        .replace(/<\?xml[\s\S]*?\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<title>[\s\S]*?<\/title>/g, '')
        .replace(/\s(width|height)="1em"/g, '')
        .replace(/\sstyle="[^"]*"/g, '')
        .replace(/>\s+</g, '><')
        .trim();
      expect(agentIconSvg(provider), provider).toBe(normalized);
    }
  });
});

// The icon assets are read at RUNTIME from the bundle's own directory. The
// extension ships as ONE esbuild bundle (`dist/extension.js`), so every module
// inside it sees `import.meta.url` collapsed to `dist/` — a path derived from
// THIS module's own `import.meta.url` resolves to `src/model/` unbundled but
// `dist/` bundled, which is where the agent-core icons silently vanished from
// every picker. The one correct anchor is `RUNTIME_ASSETS_ROOT` joined with the
// full src-relative path (see runtimeAssetsRoot.ts).
describe('agent icon asset root (bundled-runtime correctness)', () => {
  it('resolves the icons dir from RUNTIME_ASSETS_ROOT, not this module dir', () => {
    expect(AGENT_ICONS_DIR).toBe(join(RUNTIME_ASSETS_ROOT, 'model', 'icons', 'agent'));
  });

  it('reads every registered icon from that dir', () => {
    for (const [provider, meta] of Object.entries(AGENT_PROVIDERS)) {
      expect(existsSync(join(AGENT_ICONS_DIR, meta.icon)), provider).toBe(true);
      expect(agentIconSvg(provider), provider).toContain('<svg');
    }
  });
});
