import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTE_META,
  ROUTE_ICONS,
  ROUTE_ICONS_DIR,
  routeIconSvg,
  routeIdentityJs,
} from './routeIdentity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, 'icons', 'route');

describe('ROUTE_META', () => {
  it('names the three known routes', () => {
    expect(ROUTE_META.opencode?.name).toBe('OpenCode Zen');
    expect(ROUTE_META['opencode-go']?.name).toBe('OpenCode Go');
    expect(ROUTE_META.openrouter?.name).toBe('OpenRouter');
  });

  it('badges the two OpenCode subscriptions and nothing else', () => {
    expect(ROUTE_META.opencode?.badge).toBe('Z');
    expect(ROUTE_META['opencode-go']?.badge).toBe('Go');
    expect(ROUTE_META.openrouter?.badge).toBeUndefined();
  });

  it('classifies every route as a subscription or an API-key route', () => {
    expect(ROUTE_META.opencode?.billing).toBe('subscription');
    expect(ROUTE_META['opencode-go']?.billing).toBe('subscription');
    expect(ROUTE_META.openrouter?.billing).toBe('api-key');
    for (const [route, meta] of Object.entries(ROUTE_META)) {
      expect(['subscription', 'api-key'], route).toContain(meta.billing);
    }
  });

  it('emits the billing of each route into the AP_ROUTES page global', () => {
    const routes = new Function(`${routeIdentityJs()}\nreturn AP_ROUTES;`)() as Record<string, { billing: string }>;
    expect(routes.opencode?.billing).toBe('subscription');
    expect(routes.openrouter?.billing).toBe('api-key');
  });

  it('every registered icon asset exists', () => {
    for (const meta of Object.values(ROUTE_META)) {
      expect(existsSync(join(ICONS, meta.icon)), meta.icon).toBe(true);
    }
  });

  it('every icon is monochrome — currentColor, no baked colour or paint server', () => {
    for (const [route, meta] of Object.entries(ROUTE_META)) {
      const raw = readFileSync(join(ICONS, meta.icon), 'utf8');
      expect(raw, route).toMatch(/fill="currentColor"/);
      expect(raw, route).not.toMatch(/fill="#/);
      expect(raw, route).not.toMatch(/<(mask|filter|linearGradient|radialGradient)/i);
    }
  });

  it('loads a normalized inline SVG (no width/height/style/title, no inter-tag space)', () => {
    const svg = routeIconSvg('openrouter');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/width="1em"/);
    expect(svg).not.toMatch(/height="1em"/);
    expect(svg).not.toMatch(/<title>/);
    expect(svg).not.toMatch(/>\s+</);
  });

  it('returns empty for an unknown route (the picker then draws a monogram)', () => {
    expect(routeIconSvg('nope')).toBe('');
  });

  it('resolves the icon directory off the runtime assets root', () => {
    expect(ROUTE_ICONS_DIR.endsWith(join('model', 'icons', 'route'))).toBe(true);
    expect(ROUTE_ICONS.openrouter).toContain('<svg');
  });
});

describe('routeIdentityJs', () => {
  it('emits the AP_ROUTES global the picker option reads', () => {
    const js = routeIdentityJs();
    expect(js.startsWith('var AP_ROUTES = ')).toBe(true);
    const map = JSON.parse(js.slice('var AP_ROUTES = '.length).replace(/;$/, '')) as Record<
      string,
      { name: string; badge: string; iconSvg: string }
    >;
    expect(Object.keys(map).sort()).toEqual(['opencode', 'opencode-go', 'openrouter']);
    expect(map['opencode-go']).toEqual({
      name: 'OpenCode Go',
      badge: 'Go',
      billing: 'subscription',
      iconSvg: routeIconSvg('opencode-go'),
    });
    expect(map.openrouter?.badge).toBe('');
  });
});
