import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'webview.html'), 'utf8');
const STYLE = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>') + '</style>'.length);

/**
 * Guards on the dashboard page itself (`webview.html`): the static shell the React app draws into, the injection markers
 * the host fills in, the one line of page script, and the inline stylesheet's token budget. Everything the user sees
 * and does is the React app (`app/**`), pinned by its own tests and by the parity suite in `parity/`; the CSP and nonce
 * are pinned for every webview in `../webviewCsp.test.ts`.
 */
describe('dashboard page — the shell and the injection markers', () => {
  it('carries the React anchor and every injection marker — each one fails silently when lost', () => {
    // The injector no-ops on a marker-less document by design. The app bundle, its stylesheet, the provider and agent
    // runtimes (the app calls their helpers), the shared server-logs runtime and the palette are all load-bearing.
    expect(HTML).toContain('<div id="root"></div>');
    for (const marker of [
      '<!--KARST_CSP-->',
      '/*KARST_DS_CSS*/',
      '/*KARST_DS_JS*/',
      '/*KARST_PROVIDER_CSS*/',
      '/*KARST_PROVIDER_JS*/',
      '/*KARST_AGENT_CSS*/',
      '/*KARST_AGENT_JS*/',
      '/*KARST_AGENT_PICKER_CSS*/',
      '/*KARST_AGENT_PICKER_JS*/',
      '/*KARST_PALETTE*/',
      '/*KARST_SERVER_LOGS_VIEW_CSS*/',
      '/*KARST_SERVER_LOGS_VIEW_JS*/',
      '/*KARST_WEBVIEW_SEND_DASHBOARD*/',
      '/*KARST_DASHBOARD_APP*/',
      '/*KARST_DASHBOARD_APP_CSS*/',
    ]) {
      expect(HTML, `missing marker: ${marker}`).toContain(marker);
    }
  });

  it('keeps the static region roots the React app draws into', () => {
    for (const root of [
      'class="dhead"',
      'id="headerMeta"',
      'id="rail"',
      'id="inside"',
      'id="blocked"',
      'id="subtaskPanel"',
      'class="panel svpanel"',
      'id="worktreesPanel"',
      'class="panel span prpanel"',
      'id="artPanel"',
      'id="storedPanel"',
      'id="ticketDataHost"',
      'id="artView"',
      'id="termView"',
      'id="logsView"',
      'id="envView"',
    ]) {
      expect(HTML, `missing region root: ${root}`).toContain(root);
    }
    // Regions are drawn by the app: no marker of the retired vanilla/React coexistence is left in the shell.
    expect(HTML).not.toContain('data-react-owned');
    expect(HTML).not.toMatch(/island|transitional/i);
  });

  it('previews ticket data through a modal drawer wrapper, never a hover', () => {
    expect(HTML).toContain('id="ticketDataHost"');
    expect(HTML).not.toContain('id="ticketDataDrawer"');
  });

  it('stays uncapped in width (UI-R48)', () => {
    expect(HTML).not.toContain('--k-content-max');
  });
});

describe('dashboard page — the only script besides the injected runtimes and the app bundle', () => {
  const script = HTML.slice(HTML.indexOf('<script>') + '<script>'.length, HTML.indexOf('</script>'));
  /** The script with the injection markers and every comment removed: what the page itself executes. */
  const code = script
    .replace(/\/\*KARST_[A-Z_]+\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim();

  it('is one script block', () => {
    expect([...HTML.matchAll(/<script\b/g)]).toHaveLength(1);
  });

  it('executes a single line of its own: the `esc` the injected server-logs runtime escapes through', () => {
    expect(code).toBe('const esc = karstEsc;');
  });

  it('owns no persistence, no listener and no DOM access (the React app does all of it)', () => {
    expect(HTML).not.toMatch(/vscode\.(get|set)State/);
    expect(HTML).not.toMatch(/addEventListener|querySelector|getElementById|innerHTML|classList/);
    expect(HTML).not.toMatch(/karst:persist|karst:srvFilter|karstSettle/);
  });

  it('puts the app bundle after the typed senders it reads (`vscode`, `karstSend`) and before the page line', () => {
    const at = (marker: string): number => script.indexOf(marker);
    expect(at('/*KARST_WEBVIEW_SEND_DASHBOARD*/')).toBeGreaterThan(-1);
    expect(at('/*KARST_DASHBOARD_APP*/')).toBeGreaterThan(at('/*KARST_WEBVIEW_SEND_DASHBOARD*/'));
    expect(at('const esc = karstEsc;')).toBeGreaterThan(at('/*KARST_DASHBOARD_APP*/'));
    expect(at('/*KARST_SERVER_LOGS_VIEW_JS*/')).toBeLessThan(at('/*KARST_DASHBOARD_APP*/'));
  });
});

describe('dashboard page — the inline stylesheet', () => {
  it('lets the hidden ATTRIBUTE actually hide a .k-btn/.k-iconbtn (PR #166)', () => {
    // `.k-btn`/`.k-iconbtn` set `display:inline-flex` in author CSS, which overrides the UA `[hidden]{display:none}`
    // regardless of specificity, so toggling the `hidden` attribute (Confirm ship, the board link) never hid them. The
    // author `[hidden]` rule must WIN the cascade: equal specificity, so it sits after the injected design-system CSS.
    expect(HTML).toMatch(/\.hidden\{display:none\}/);
    expect(HTML).toMatch(/(^|;|})[^{]*\[hidden\]\s*\{\s*display\s*:\s*none\s*\}/);
    expect(HTML.indexOf('[hidden]')).toBeGreaterThan(HTML.indexOf('/*KARST_DS_CSS*/'));
  });

  it('gives every panel header the same declared height', () => {
    // The panels sit side by side in one grid row: a header that sizes itself to its own contents puts its body on a
    // different line from its neighbour's. Composed from tokens rather than a bare 39px literal (UI-R04).
    expect(HTML).toMatch(/--phead-h:calc\(var\(--k-control-h-lg\) \+ var\(--k-space-4\) \+ var\(--k-border-w\)\)/);
    expect(HTML).toMatch(/\.phead\{[^}]*min-height:var\(--phead-h\)/);
    expect(HTML).not.toMatch(/\.svpanel \.phead\{[^}]*(?:min-)?height:/);
    expect(HTML).not.toMatch(/\.svpanel \.phead\{[^}]*padding:/);
  });

  it('carries no hex or rgba() color literal in <style> (UI-R04)', () => {
    expect(STYLE).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(STYLE).not.toMatch(/rgba?\(/);
  });

  it('leaves exactly one raw px value in <style>: the narrow-width breakpoint (UI-R04)', () => {
    // Everything else is a --k-* token or a calc() of tokens. An @media condition cannot read a custom property, so its
    // 699px is literal by construction (the rule sits between the Inside literal-budget markers). The panels' and views'
    // own literals live in their `app/*.css` files. A NEW raw px must not slip in; shrinking this set is always welcome.
    const withoutComments = STYLE.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).toContain('@media (max-width: 699px){\n    .grid{grid-template-columns:1fr}');
    expect([...withoutComments.matchAll(/[0-9]+(\.[0-9]+)?px/g)].map((m) => m[0])).toEqual(['699px']);
  });

  it('carries no bare numeric border-radius — every radius is a token or the 0/50% exemptions', () => {
    const radii = [...STYLE.matchAll(/border-radius:\s*([^;{}]+)[;}]/g)].map((m) => m[1]!.trim());
    for (const value of radii) {
      const stripped = value
        .replace(/calc\(/g, '')
        .replace(/var\(--[\w-]+\)/g, '')
        .replace(/[+\-*/()]/g, ' ')
        .replace(/\b0\b/g, '')
        .replace(/50%/g, '')
        .trim();
      expect(stripped, `unexpected content in border-radius: "${value}"`).toBe('');
    }
  });

  it('nulls animation under reduced motion without hiding the spinner ring (UI-R30)', () => {
    // The ring stops spinning but stays VISIBLE (a static ring), because `aria-busy`/`disabled` carry the pending state
    // — never `display:none`. Scoped to the media block that names the spinner: the file carries several.
    const medias: string[] = [];
    let at = 0;
    while ((at = HTML.indexOf('@media (prefers-reduced-motion:reduce){', at)) !== -1) {
      let depth = 0;
      let end = at;
      for (let i = HTML.indexOf('{', at); i < HTML.length; i += 1) {
        if (HTML[i] === '{') depth += 1;
        else if (HTML[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      medias.push(HTML.slice(at, end));
      at = end;
    }
    const rm = medias.find((b) => b.includes('.spin')) ?? '';
    expect(rm).toContain('animation:none');
    expect(rm).not.toContain('display:none');
    expect(rm).toMatch(/\.spin[^{]*\{[^}]*animation:none/);
  });
});
