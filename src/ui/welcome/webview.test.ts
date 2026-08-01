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
 * Text-level guards on the welcome webview (Task 3.1 of the UI remediation
 * plan). Standalone HTML with no DOM harness — same rationale as every other
 * `webview.test.ts` in this repo (STYLE-GUIDE §5).
 */
describe('welcome webview.html', () => {
  it('carries the design-system markers ahead of any file-local rule (UI-R03)', () => {
    const style = styleBlock();
    expect(style.trimStart().startsWith('/*KARST_DS_CSS*/')).toBe(true);
    const script = scriptBlock();
    expect(script.trimStart().startsWith('/*KARST_DS_JS*/')).toBe(true);
    expect(HTML).toContain('<!--KARST_CSP-->');
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

  it('every static <button> carries a k-btn primitive and a variant', () => {
    const buttonTags = [...HTML.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    expect(buttonTags.length).toBeGreaterThan(0);
    for (const tag of buttonTags) {
      expect(tag, tag).toMatch(/class="[^"]*\bk-btn\b/);
      expect(tag, tag).toMatch(/k-btn--(primary|secondary|ghost|danger|link)/);
    }
  });

  it('every JS-created button carries a k-btn primitive and a variant', () => {
    const script = scriptBlock();
    // Both dynamic buttons (checklist "Create karst.yml" and the tutorial
    // step's Open Settings / Create Ticket) assign className once — assert
    // each assignment names k-btn plus a real variant.
    const assigns = [...script.matchAll(/\.className\s*=\s*'([^']*)'/g)].map((m) => m[1]!);
    const buttonAssigns = assigns.filter((c) => c.includes('k-btn'));
    expect(buttonAssigns.length).toBeGreaterThanOrEqual(2);
    for (const cls of buttonAssigns) {
      expect(cls, cls).toMatch(/k-btn--(primary|secondary|ghost|danger|link)/);
    }
  });

  it('routes create-manifest through karstAction instead of firing on an un-disabled click (UI-R11, R12)', () => {
    const script = scriptBlock();
    expect(script).not.toContain("b.onclick = () => post('create-manifest')");
    expect(script).toMatch(/karstAction\(b,\s*\(requestId\)\s*=>\s*post\('create-manifest',\s*requestId\)\)/);
  });

  it('routes #recheck and #dismiss through karstAction, not a bare onclick', () => {
    const script = scriptBlock();
    expect(script).not.toContain("getElementById('recheck').onclick");
    expect(script).not.toContain("getElementById('dismiss').onclick");
    expect(script).toContain("karstAction(document.getElementById('recheck')");
    expect(script).toContain("karstAction(document.getElementById('dismiss')");
  });

  it('handles action-result by settling the pending control (UI-R13)', () => {
    const script = scriptBlock();
    expect(script).toContain("msg.type === 'action-result'");
    expect(script).toContain('karstSettle(msg.requestId, msg.ok, msg.message)');
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

  it('esc() is not needed here: rendering goes through textContent/createElement, never innerHTML interpolation', () => {
    const script = scriptBlock();
    expect(script).not.toContain('innerHTML = `');
    expect(script).not.toMatch(/innerHTML\s*\+=/);
  });
});
