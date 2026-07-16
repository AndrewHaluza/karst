import { describe, it, expect } from 'vitest';
import {
  PROVIDER_LABELS,
  CLICKUP_SVG,
  PROVIDER_CSS_MARKER,
  PROVIDER_JS_MARKER,
  providerIdentityCss,
  providerIdentityJs,
  injectProviderIdentity,
} from './providerIdentity.js';

describe('PROVIDER_LABELS', () => {
  it('title-cases the known providers', () => {
    expect(PROVIDER_LABELS.clickup).toBe('ClickUp');
    expect(PROVIDER_LABELS.manual).toBe('Manual');
  });
});

describe('providerIdentityCss', () => {
  it('defines the badge/icon/name rules', () => {
    const css = providerIdentityCss();
    expect(css).toContain('.provbadge{');
    expect(css).toContain('.provicon{');
    expect(css).toContain('.provname{');
  });
});

describe('providerIdentityJs', () => {
  const js = providerIdentityJs();

  it('embeds the label map and ClickUp SVG as JS literals', () => {
    expect(js).toContain('PROVIDER_LABELS');
    expect(js).toContain('ClickUp');
    expect(js).toContain(JSON.stringify(CLICKUP_SVG));
  });

  it('defines providerBadgeHtml', () => {
    expect(js).toContain('function providerBadgeHtml(provider)');
  });

  it('is executable and renders a clickup badge with icon + label', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${js}\nreturn providerBadgeHtml;`);
    const providerBadgeHtml = fn();
    const out = providerBadgeHtml('clickup');
    expect(out).toContain('provbadge');
    expect(out).toContain('<svg');
    expect(out).toContain('ClickUp');
  });

  it('renders manual as label-only, no icon', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${js}\nreturn providerBadgeHtml;`);
    const providerBadgeHtml = fn();
    const out = providerBadgeHtml('manual');
    expect(out).toContain('Manual');
    expect(out).not.toContain('<svg');
    expect(out).toContain('provbadge manual');
  });

  it('falls back to a title-cased raw id for an unknown provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${js}\nreturn providerBadgeHtml;`);
    const providerBadgeHtml = fn();
    const out = providerBadgeHtml('linear');
    expect(out).toContain('Linear');
    expect(out).not.toContain('<svg');
  });

  it('escapes an unknown provider id so it cannot inject markup', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${js}\nreturn providerBadgeHtml;`);
    const providerBadgeHtml = fn();
    const out = providerBadgeHtml('<img onerror=alert(1)>');
    expect(out).not.toContain('<img');
  });
});

describe('injectProviderIdentity', () => {
  it('replaces both markers with their emitted blocks', () => {
    const html = `<style>${PROVIDER_CSS_MARKER}</style><script>${PROVIDER_JS_MARKER}\nconst x=1;</script>`;
    const out = injectProviderIdentity(html);
    expect(out).not.toContain(PROVIDER_CSS_MARKER);
    expect(out).not.toContain(PROVIDER_JS_MARKER);
    expect(out).toContain('.provbadge{');
    expect(out).toContain('function providerBadgeHtml');
  });

  it('is a no-op when a marker is absent', () => {
    expect(injectProviderIdentity('<div>no marker</div>')).toBe('<div>no marker</div>');
  });
});
