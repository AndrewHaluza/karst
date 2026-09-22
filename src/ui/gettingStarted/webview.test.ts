import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

function styleBlock(): string {
  const start = HTML.indexOf('<style>');
  const end = HTML.indexOf('</style>');
  expect(start, '<style> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</style> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<style>'.length, end);
}

function scriptBlock(): string {
  const start = HTML.indexOf('<script>');
  const end = HTML.indexOf('</script>');
  expect(start, '<script> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</script> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<script>'.length, end);
}

/**
 * Text-level guards on the Getting Started webview (Task 3.1 of the UI remediation
 * plan). Standalone HTML with no DOM harness — same rationale as every other
 * `webview.test.ts` in this repo (STYLE-GUIDE §5).
 */
describe('gettingStarted webview.html', () => {
  it('carries the design-system markers ahead of any file-local rule (UI-R03)', () => {
    const style = styleBlock();
    expect(style.trimStart().startsWith('/*KARST_DS_CSS*/')).toBe(true);
    const script = scriptBlock();
    expect(script.trimStart().startsWith('/*KARST_DS_JS*/')).toBe(true);
    expect(HTML).toContain('<!--KARST_CSP-->');
  });

  it('the splash header carries the approved full-color mark, not the old graph', () => {
    expect(HTML).toContain('M 96 20');
    expect(HTML).toContain('cx="106.5" cy="111.5" r="26.5"');
    expect(HTML).not.toContain('cx="6"');
    expect(HTML).not.toContain('7.6 7.6');
  });

  it('contains no raw hex/rgb/px/rem style literal outside the injected tokens (UI-R04)', () => {
    // This was the only webview still using `rem`, with no `:root` block and a
    // hex fallback (#3fb950/#f85149) duplicating the shared status ramp. Every
    // length below the marker must now resolve through a --k-* token.
    const style = styleBlock();
    const local = style.slice(style.indexOf('/*KARST_DS_CSS*/') + '/*KARST_DS_CSS*/'.length);
    const offenders = local.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b[0-9]+(\.[0-9]+)?(px|rem)\b/g);
    expect(offenders, JSON.stringify(offenders)).toBeNull();
  });

  it('sets an explicit page background (UI-R05), like every other webview\'s body rule', () => {
    // Without this the page falls back to the browser default (white),
    // which reads correctly in light theme but leaves --k-text (near-white
    // under dark/HC) painted on a white surface — unreadable. Every other
    // webview (dashboard, usage, resources, sidebar) sets this on body.
    const style = styleBlock();
    const bodyRule = style.match(/body\s*\{[^}]*\}/);
    expect(bodyRule, 'no body { } rule found').not.toBeNull();
    expect(bodyRule![0]).toMatch(/background:\s*var\(--k-bg\)/);
  });

  it('declares no local :root block — tokens come from the injected design system', () => {
    const style = styleBlock();
    expect(style).not.toContain(':root');
  });

  it('does not restyle a bare button/button.secondary/hover-as-dimming rule', () => {
    const style = styleBlock();
    expect(style).not.toMatch(/(^|\s)button\s*\{/);
    expect(style).not.toContain('button.secondary');
    expect(style).not.toContain('button:hover{opacity:.9}');
    expect(style).not.toContain('button:hover { opacity: 0.9; }');
  });

  it('no longer carries the old unlabelled #error live-region substitute (UI-R27)', () => {
    expect(HTML).not.toContain('id="error"');
    const script = scriptBlock();
    expect(script).not.toContain("msg.type === 'error'");
  });

  it('gives the done/not-done status dot a role and an accessible name in words, never colour alone (UI-R28)', () => {
    const script = scriptBlock();
    expect(script).toContain("dot.setAttribute('role', 'img')");
    expect(script).toMatch(/dot\.setAttribute\('aria-label',\s*it\.done \? 'Done' : 'Not done'\)/);
    expect(script).toMatch(/dot\.className = 'k-dot ' \+ \(it\.done \? 'k-dot--passed' : 'k-dot--failed'\)/);
  });

  it('every title attribute is a non-empty, period-free string no longer than 80 characters (UI-R20)', () => {
    const staticTitles = [...HTML.matchAll(/title="([^"]*)"/g)].map((m) => m[1]!);
    const dynamicTitles = [...scriptBlock().matchAll(/\.title\s*=\s*'([^']*)'/g)].map((m) => m[1]!);
    const dynamicTernaries = [...scriptBlock().matchAll(/\.title\s*=\s*isSettings \? '([^']*)' : '([^']*)'/g)]
      .flatMap((m) => [m[1]!, m[2]!]);
    for (const title of [...staticTitles, ...dynamicTitles, ...dynamicTernaries]) {
      expect(title.length, title).toBeGreaterThan(0);
      expect(title.length, title).toBeLessThanOrEqual(80);
      expect(title.endsWith('.'), title).toBe(false);
    }
  });

  it('the create-manifest button carries a title, because its effect (writing to disk) is not confined to the screen', () => {
    const script = scriptBlock();
    expect(script).toContain("b.title = 'Write a starter karst.yml to the workspace root'");
  });

  it('carries a Report an issue entry on the page (§ report an issue)', () => {
    expect(HTML).toContain('Report an issue');
    expect(HTML).toContain('id="report-issue"');
  });

  it('tells the reader what Report an issue does, when to use it, and where the report goes', () => {
    // The ticket asks for a short usage description, not a bare button: a
    // reporter who cannot tell what gets sent will not press it. Assert the
    // three facts individually so a copy edit that drops one still fails.
    const body = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script>'));
    const section = body.slice(body.indexOf('Report an issue'));
    // What it does + where it goes.
    expect(section).toMatch(/redact/i);
    expect(section).toMatch(/GitHub/);
    // When to click it.
    expect(section).toMatch(/wrong|misbehav|stuck|unexpected/i);
    // Nothing leaves the machine unreviewed.
    expect(section).toMatch(/review|before/i);
  });

  it('routes #report-issue through karstAction, not a bare onclick (UI-R11, R12)', () => {
    const script = scriptBlock();
    expect(script).not.toContain("getElementById('report-issue').onclick");
    expect(script).toContain("karstAction(document.getElementById('report-issue')");
    expect(script).toMatch(/post\('report-issue',\s*requestId\)/);
  });

  it('esc() is not needed here: rendering goes through textContent/createElement, never innerHTML interpolation', () => {
    const script = scriptBlock();
    expect(script).not.toContain('innerHTML = `');
    expect(script).not.toMatch(/innerHTML\s*\+=/);
  });
});
