import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectPalette } from '../../model/palette.js';
import { injectProviderIdentity } from '../../model/providerIdentity.js';
import { injectAgentIdentity } from '../../model/agentIdentity.js';
import { injectServerLogsView } from '../../model/serverLogsView.js';
import { injectWebviewSend } from '../../model/webviewSendInjector.js';
import { decodeAnsi, formatLineTime, toLogLines } from './logLine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'webview.html'), 'utf8');
const appFile = (name: string): string => readFileSync(join(HERE, 'app', name), 'utf8');
const SERVER_LOGS_JS = readFileSync(join(HERE, '..', '..', 'model', 'serverLogsView.webview.js'), 'utf8');
const SERVER_LOGS_CSS = readFileSync(join(HERE, '..', '..', 'model', 'serverLogsView.webview.css'), 'utf8');

/**
 * The dashboard webview hydrated exactly as the host renders it (design system, palette, provider and agent identity,
 * the shared server-logs runtime, the typed senders): what the shared-surface guards below read.
 */
const HYDRATED = injectWebviewSend(
  injectServerLogsView(
    injectAgentIdentity(injectProviderIdentity(injectPalette(injectDesignSystem(HTML)))),
  ),
);

class FakeElement {
  innerHTML = '';
  textContent = '';
  value = '';
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  attributes: Record<string, string> = {};
  classes = new Set<string>();
  marks: FakeElement[] = [];
  tabs: FakeElement[] = [];
  handlers: Record<string, (e: unknown) => void> = {};
  classList = {
    add: (name: string): void => {
      this.classes.add(name);
    },
    remove: (name: string): void => {
      this.classes.delete(name);
    },
  };
  addEventListener(kind: string, fn: (e: unknown) => void): void { this.handlers[kind] = fn; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  focus(): void { this.attributes.focused = 'yes'; }
  scrollIntoView(): void { /* no layout in the harness */ }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '.k-loghit') return this.marks;
    if (selector === '[data-log-tab]') return this.tabs;
    return [];
  }
}

type LogsView = {
  open(): void;
  handleInitial(servers: Array<{ service: string; content: string; truncated?: boolean; state?: string; message?: string }>, key?: string): void;
  handleOutput(service: string, text: string): void;
  handleMatchText(seq: number, text: string): void;
  handleNewText(seq: number, text: string): void;
  lineCount(): number;
  clear(): void;
};

/** Run the shipped runtime against a minimal DOM so its protocols execute. */
function bootRuntime(opts: { detached?: boolean } = {}): {
  view: LogsView;
  els: Map<string, FakeElement>;
  posted: Array<Record<string, unknown>>;
  sandbox: Record<string, unknown>;
  follow: FakeElement;
  latest: FakeElement;
  click(selector: string, value?: string): void;
} {
  const els = new Map<string, FakeElement>();
  for (const id of ['logsView', 'logsHost', 'logsSearch', 'logsMatches', 'logsStatus', 'logsTabs', 'logsTitle']) {
    els.set(id, new FakeElement());
  }
  const follow = new FakeElement();
  const latest = new FakeElement();
  const logsView = els.get('logsView')!;
  const document = {
    body: { classList: { add: (): void => undefined, remove: (): void => undefined } },
    // Before buildShell writes the root, the host element does not exist, so
    // the runtime takes its build path (and binds the root listeners).
    getElementById: (id: string) =>
      id === 'logsHost' && logsView.innerHTML === '' ? null : (els.get(id) ?? null),
    querySelector: (selector: string) =>
      selector === '[data-log-follow]' ? follow : selector === '[data-log-latest]' ? latest : null,
  };
  const sandbox: Record<string, unknown> = {
    window: {},
    document,
    esc: (value: unknown) =>
      String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!),
  };
  runInNewContext(SERVER_LOGS_JS, sandbox);
  const factory = (sandbox.window as { createServerLogsView: (o: { post: (m: unknown) => void; detached?: boolean }) => LogsView }).createServerLogsView;
  const posted: Array<Record<string, unknown>> = [];
  const view = factory({ post: (m) => posted.push(m as Record<string, unknown>), detached: opts.detached });
  view.open();
  const click = (selector: string, value?: string): void => {
    const target = {
      closest: (s: string) =>
        s === selector ? { getAttribute: () => value ?? null, focus: () => undefined } : null,
    };
    logsView.handlers.click!({ target });
  };
  return { view, els, posted, sandbox, follow, latest, click };
}

/**
 * The shared server-logs surface (Task 3): the control strip, the ANSI
 * rendering and the wiring between the dashboard and the shared factory. The
 * dashboard no longer owns the surface — it owns the open flag and the host
 * request — so the controls are asserted where they actually live, in the
 * injected runtime, and the decoder is pinned to `logLine.ts`'s.
 */
describe('shared server logs surface', () => {
  it('carries the control strip the shared runtime renders', () => {
    for (const hook of [
      'id="logsSearch"',
      'data-log-filter',
      'data-log-current-run',
      'data-log-clear',
      'data-log-detach',
      'data-log-prev',
      'data-log-next',
      'data-log-follow',
      'data-log-latest',
      'data-log-wrap',
      'data-log-copy',
      'id="logsHost"',
      'id="logsMatches" role="status"',
    ]) {
      expect(HYDRATED, `missing logs control: ${hook}`).toContain(hook);
    }
  });

  it('omits Open in Window when the factory is detached', () => {
    // The standalone panel has no second window to open, so the control is
    // conditional on the factory option rather than always rendered.
    expect(SERVER_LOGS_JS).toMatch(/detached \? ''[\s\S]*?data-log-detach/);
  });

  it('wires the dashboard to the shared factory, not a private surface', () => {
    expect(HTML).toContain('/*KARST_SERVER_LOGS_VIEW_CSS*/');
    expect(HTML).toContain('/*KARST_SERVER_LOGS_VIEW_JS*/');
    // The React wrapper (app/ServerLogsView.tsx) drives the runtime; the page only carries the injection markers.
    const wrapper = appFile('ServerLogsView.tsx');
    expect(wrapper).toContain('createServerLogsView');
    expect(wrapper).toContain('.open()');
    expect(wrapper).toContain('.handleInitial(');
    expect(wrapper).toContain('.handleOutput(');
    expect(wrapper).toContain('.handleMatchText(');
    expect(HTML).not.toContain('logsViewInstance');
    // The old inline surface is gone wholesale, not merely unused.
    expect(HTML).not.toContain('renderLogsContent');
    expect(HTML).not.toContain('logsMergedLines');
  });

  it('posts server-logs-detach from the shared control, and no unreachable host action', () => {
    expect(SERVER_LOGS_JS).toContain("{ type: 'server-logs-detach' }");
  });

  it('ships CSS rules for every class the decoder emits (UI-R10)', () => {
    // The ANSI classes are only in the DOM once lines render, so the load-time
    // RUNTIME sweep cannot check them — this pins their rules here.
    for (const cls of ['k-ansi-fg-green', 'k-ansi-bg-red', 'k-ansi-fg-bright-white', 'k-ansi-bold']) {
      expect(SERVER_LOGS_CSS, `no rule for ${cls}`).toContain('.' + cls);
    }
    expect(SERVER_LOGS_CSS).toContain('.k-loghit');
  });

  it('posts the search count and renders the host’s match text, dropping a stale answer', () => {
    const { view, els, posted } = bootRuntime();
    view.handleInitial([{ service: 'web', content: 'timeout here\nnothing else' }]);
    expect(posted).toEqual([]);
    els.get('logsView')!.handlers.input!({ target: { id: 'logsSearch', value: 'timeout' } });
    expect(posted).toEqual([{ type: 'server-logs-match-count', count: 1, seq: 1 }]);
    view.handleMatchText(1, '1 match');
    expect(els.get('logsMatches')!.textContent).toBe('1 match');
    view.handleMatchText(2, 'stale answer');
    expect(els.get('logsMatches')!.textContent).toBe('1 match');
    els.get('logsView')!.handlers.input!({ target: { id: 'logsSearch', value: 'timeout' } });
    expect(posted.at(-1)).toEqual({ type: 'server-logs-match-count', count: 1, seq: 2 });
    view.handleMatchText(2, '1 match');
    expect(els.get('logsMatches')!.textContent).toBe('1 match');
  });

  it('clears the match text when the query is empty and holds no plural literal of its own', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([{ service: 'web', content: 'timeout here' }]);
    els.get('logsView')!.handlers.input!({ target: { id: 'logsSearch', value: 'timeout' } });
    view.handleMatchText(1, '1 match');
    els.get('logsView')!.handlers.input!({ target: { id: 'logsSearch', value: '  ' } });
    expect(els.get('logsMatches')!.textContent).toBe('');
    expect(SERVER_LOGS_JS).not.toContain("'no matches'");
    expect(SERVER_LOGS_JS).not.toContain("+ ' matches'");
  });

  it('clear() drops the lines and re-renders, posting nothing', () => {
    const from = SERVER_LOGS_JS.indexOf('function clear()');
    const to = SERVER_LOGS_JS.indexOf('function handleInitial');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = SERVER_LOGS_JS.slice(from, to);
    expect(body).toMatch(/lines = \[\];/);
    expect(body).toContain('renderContent();');
    expect(body, 'clear must never reach the host — tailing continues').not.toContain('post(');
  });

  it('matches every occurrence case-insensitively by splitting the escaped text on the escaped query', () => {
    const from = SERVER_LOGS_JS.indexOf('function highlight');
    const body = SERVER_LOGS_JS.slice(from, from + 700);
    expect(body).toContain('esc(text)');
    expect(body).toContain('esc(query)');
    expect(body).toContain('class="k-loghit"');
    // Escaped-then-split, never a regex over unescaped input.
    expect(body).not.toMatch(/new RegExp|\.replace\(/);
  });

  /**
   * Mirrored TS→HTML constants ARE behavior (UI-INVARIANTS.md): the shipped JS
   * decoder must agree with the tested TS one, or the surface renders one thing
   * while `logLine.ts` claims another. The assertion evaluates the FILE'S OWN
   * TEXT — never a second decoder fabricated in the test.
   */
  it('the ported decoder and logLine.ts agree on an ANSI line', () => {
    const sandbox: Record<string, unknown> = { window: {} };
    runInNewContext(SERVER_LOGS_JS, sandbox);
    const ported = sandbox.KARST_SERVER_LOGLINE as {
      decodeAnsi: (text: string) => Array<{ text: string; classes: string[] }>;
    };
    expect(ported, 'the shared file does not expose KARST_SERVER_LOGLINE').toBeTruthy();
    const input = '\u001b[32mok\u001b[39m';
    const portedSegments = ported.decodeAnsi(input);
    const tsSegments = decodeAnsi(input);
    expect(portedSegments.map((s) => ({ text: s.text, classes: s.classes }))).toEqual(
      tsSegments.map((s) => ({ text: s.text, classes: s.classes })),
    );
    expect(portedSegments[0]!.classes).toContain('k-ansi-fg-green');
  });

  it('the ported line helpers and logLine.ts agree on the timestamp strip and the local time', () => {
    const sandbox: Record<string, unknown> = { window: {} };
    runInNewContext(SERVER_LOGS_JS, sandbox);
    const ported = sandbox.KARST_SERVER_LOGLINE as {
      toLogLines: (service: string, text: string, startSeq: number) => Array<{ text?: string; segments: Array<{ text: string }> }>;
      formatLineTime: (iso: string) => string;
    };
    const line = '2024-01-02T03:04:05.123Z hello';
    expect(ported.toLogLines('web', line, 0)[0]!.segments.map((s) => s.text).join('')).toBe(' hello');
    expect(ported.toLogLines('web', line, 0)[0]!.segments.map((s) => s.text).join('')).toBe(
      toLogLines('web', line, 0)[0]!.segments.map((s) => s.text).join(''),
    );
    expect(ported.formatLineTime('2024-01-02T03:04:05.123Z')).toBe(formatLineTime('2024-01-02T03:04:05.123Z'));
  });

  it('drillHead swaps the runtime title and Close for the slot the dashboard header fills; tabs stay runtime state', () => {
    expect(SERVER_LOGS_JS).toContain("o.drillHead === true");
    expect(SERVER_LOGS_JS).toContain('id="logsDrillHead"');
    // A tab click only sets activeTab and re-renders: no post, so the history never sees it.
    const tabBranch = SERVER_LOGS_JS.slice(SERVER_LOGS_JS.indexOf("closest('[data-log-tab]')"), SERVER_LOGS_JS.indexOf("closest('[data-log-prev]')"));
    expect(tabBranch).not.toContain('post(');
  });
});

describe('server logs surface — LG-1: the newest output of a large log', () => {
  it('shows a one-line note above the lines of a truncated service', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([
      { service: 'api', content: '[Earlier output not shown: 14.2 MB]\nnewest line\n', truncated: true },
    ]);
    expect(els.get('logsHost')!.innerHTML).toContain('class="logtrunc"');
    expect(els.get('logsHost')!.innerHTML).toContain('Showing the newest output.');
    expect(els.get('logsHost')!.innerHTML).toContain('newest line');
  });

  it('shows no note when nothing was truncated', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([{ service: 'api', content: 'only line\n' }]);
    expect(els.get('logsHost')!.innerHTML).not.toContain('logtrunc');
  });
});

describe('server logs surface — LG-3: no Close in the standalone panel', () => {
  it('omits the Close control when the factory is detached', () => {
    const { els } = bootRuntime({ detached: true });
    expect(els.get('logsView')!.innerHTML).not.toContain('data-log-close');
    // The dashboard (not detached) still owns its own Close.
    const dashboard = bootRuntime();
    expect(dashboard.els.get('logsView')!.innerHTML).toContain('data-log-close');
  });
});

describe('server logs surface — LG-4: Follow and Jump to latest', () => {
  it('stops auto-follow, asks the host for the new-line text, and jumps back', () => {
    const { view, els, posted, follow, latest, click } = bootRuntime();
    view.handleInitial([{ service: 'api', content: 'one\n' }]);
    click('[data-log-follow]');
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    view.handleOutput('api', 'two\nthree\n');
    const counts = posted.filter((m) => m.type === 'server-logs-new-count');
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ count: 2, seq: 1 });
    view.handleNewText(1, '2 new lines');
    expect(latest.hidden).toBe(false);
    expect(latest.textContent).toBe('2 new lines ↓');
    expect(view.lineCount()).toBe(3);
    // The button carries the HOST's text: no plural lives in the runtime.
    expect(SERVER_LOGS_JS).not.toContain("' new line'");
    click('[data-log-latest]');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    expect(latest.hidden).toBe(true);
    // Jump to latest hands the caret to the log body (the a11y focus rule).
    expect(els.get('logsHost')!.getAttribute('focused')).toBe('yes');
  });
});

describe('server logs surface — LG-5: a line cap and one render per frame', () => {
  it('keeps at most 20000 lines and drops the oldest with the start note', () => {
    const { view, els } = bootRuntime();
    const content = Array.from({ length: 25000 }, (_, i) => `line ${i}`).join('\n') + '\n';
    view.handleInitial([{ service: 'api', content }]);
    expect(view.lineCount()).toBe(20000);
    expect(els.get('logsHost')!.innerHTML).toContain('line 24999');
    expect(els.get('logsHost')!.innerHTML).not.toContain('line 4999');
    expect(els.get('logsHost')!.innerHTML).toContain('class="logtrunc"');
  });
});

describe('server logs surface — LG-6: tab semantics', () => {
  it('renders a tablist, roving tabindex and aria-selected', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([{ service: 'web', content: 'a\n' }, { service: 'api', content: 'b\n' }]);
    expect(els.get('logsView')!.innerHTML).toContain('role="tablist"');
    expect(els.get('logsView')!.innerHTML).toContain('role="tabpanel"');
    const tabs = els.get('logsTabs')!.innerHTML;
    expect(tabs).toContain('role="tab"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('aria-selected="false"');
    expect(tabs).toContain('tabindex="0"');
    expect(tabs).toContain('tabindex="-1"');
    expect(tabs).toContain('class="k-tab');
  });

  it('moves the roving focus with Left/Right/Home/End and wraps', () => {
    const { sandbox } = bootRuntime();
    const tabs = sandbox.KARST_SERVER_LOGS_TABS as { move(key: string, index: number, count: number): number };
    expect(tabs.move('ArrowRight', 0, 3)).toBe(1);
    expect(tabs.move('ArrowRight', 2, 3)).toBe(0);
    expect(tabs.move('ArrowLeft', 0, 3)).toBe(2);
    expect(tabs.move('Home', 2, 3)).toBe(0);
    expect(tabs.move('End', 0, 3)).toBe(2);
    expect(tabs.move('Enter', 0, 3)).toBe(-1);
  });
});

describe('server logs surface — LG-7: AA ANSI colours in light and hc', () => {
  it('maps the sixteen foregrounds to meaning tokens in light and both contrast themes, and keeps dark', () => {
    // The declaration of the rule whose selector names this theme and class.
    const declarationFor = (body: string, cls: string): string | null => {
      const re = new RegExp(`([^{}]*body\\.${body}[^{}]*\\.${cls}[^{}]*)\\{([^}]*)\\}`);
      return re.exec(SERVER_LOGS_CSS)?.[2] ?? null;
    };
    for (const body of ['vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
      expect(declarationFor(body, 'k-ansi-fg-red')).toBe('color:var(--k-danger)');
      expect(declarationFor(body, 'k-ansi-fg-green')).toBe('color:var(--k-success)');
      expect(declarationFor(body, 'k-ansi-fg-yellow')).toBe('color:var(--k-warning)');
      expect(declarationFor(body, 'k-ansi-fg-blue')).toBe('color:var(--k-link)');
      expect(declarationFor(body, 'k-ansi-fg-white')).toBe('color:var(--k-text)');
      expect(declarationFor(body, 'k-ansi-fg-black')).toBe('color:var(--k-text-dim)');
    }
    // Dark keeps the terminal palette: no themed override block at all.
    expect(SERVER_LOGS_CSS).not.toContain('body.vscode-dark .logsview .k-ansi-fg-red');
    // Dim is a colour, not an opacity that can drop below AA.
    expect(SERVER_LOGS_CSS).toContain('k-ansi-dim{opacity:1;color:var(--k-text-dim)}');
  });
});

describe('server logs surface — LG-8: empty, missing and unreadable are different', () => {
  it('shows the host’s explanation for a service with no output', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([
      { service: 'api', content: '', state: 'empty', message: 'api has not written to its log yet.' },
    ]);
    expect(els.get('logsHost')!.innerHTML).toContain('api has not written to its log yet.');
    expect(els.get('logsHost')!.innerHTML).toContain('class="blurb k-empty"');
  });

  it('shows the unreadable explanation for a service whose log cannot be read', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([
      { service: 'api', content: '', state: 'unreadable', message: 'Karst cannot read /logs/api.log.' },
    ]);
    expect(els.get('logsHost')!.innerHTML).toContain('Karst cannot read /logs/api.log.');
  });

  it('shows one .k-empty when the ticket has no services', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([]);
    expect(els.get('logsHost')!.innerHTML).toContain('class="blurb k-empty"');
    expect(els.get('logsHost')!.innerHTML).toContain('This ticket has no services.');
  });
});

describe('server logs surface — LG-9: loading lives in the body only', () => {
  it('shows Loading server logs… in the body and leaves the status strip empty', () => {
    const { els } = bootRuntime();
    expect(els.get('logsHost')!.innerHTML).toContain('Loading server logs…');
    expect(els.get('logsStatus')!.textContent).toBe('');
  });
});

describe('server logs surface — LG-10: the current match out of all', () => {
  it('posts count and current when the search steps', () => {
    const { view, els, posted, click } = bootRuntime();
    view.handleInitial([{ service: 'api', content: 'hit one\nhit two\n' }]);
    els.get('logsView')!.handlers.input!({ target: { id: 'logsSearch', value: 'hit' } });
    const host = els.get('logsHost')!;
    host.marks = [new FakeElement(), new FakeElement()];
    click('[data-log-next]');
    const last = posted.at(-1)!;
    expect(last).toMatchObject({ type: 'server-logs-match-count', count: 2, current: 2 });
  });
});

describe('server logs surface — LG-11: wrap', () => {
  it('pins the lines and scrolls the host when Wrap is off', () => {
    const { els, view } = bootRuntime();
    view.handleInitial([{ service: 'api', content: 'x'.repeat(200) + '\n' }]);
    const logsView = els.get('logsView')!;
    logsView.handlers.change!({ target: { hasAttribute: (n: string) => n === 'data-log-wrap', checked: false } });
    expect(logsView.classes.has('nowrap')).toBe(true);
    logsView.handlers.change!({ target: { hasAttribute: (n: string) => n === 'data-log-wrap', checked: true } });
    expect(logsView.classes.has('nowrap')).toBe(false);
    expect(SERVER_LOGS_JS).toContain('data-log-wrap');
    expect(SERVER_LOGS_CSS).toContain('overflow-wrap:anywhere');
  });
});

describe('server logs surface — LG-12: Copy and Clear view', () => {
  it('copies the plain lines shown through the host', () => {
    const { view, posted, click } = bootRuntime();
    view.handleInitial([{ service: 'api', content: 'first\nsecond\n' }]);
    click('[data-log-copy]');
    expect(posted.at(-1)).toEqual({ type: 'server-logs-copy', text: 'first\nsecond' });
  });

  it('names the clear control and says that tailing continues', () => {
    const { els } = bootRuntime();
    const shell = els.get('logsView')!.innerHTML;
    expect(shell).toContain('data-log-clear');
    expect(shell).toContain('Clear view');
    expect(shell).toContain('title="Clear the view; tailing continues"');
  });
});

describe('server logs surface — LG-13: title, local time, filter label', () => {
  it('titles the view with the host’s ticket key', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([{ service: 'api', content: 'a\n' }], 'FEAT-12');
    expect(els.get('logsTitle')!.textContent).toBe('Server logs · FEAT-12');
  });

  it('renders a stamped line’s time locally, once, with the ISO value in the title', () => {
    const { view, els } = bootRuntime();
    view.handleInitial([{ service: 'api', content: '2024-01-02T03:04:05.123Z hello\n' }]);
    const html = els.get('logsHost')!.innerHTML;
    expect(html).toContain('title="2024-01-02T03:04:05.123Z"');
    expect(html).toContain('hello');
    // The raw ISO text is not repeated in the body.
    expect(html).not.toContain('>2024-01-02T03:04:05.123Z<');
  });

  it('labels the search filter plainly', () => {
    const { els } = bootRuntime();
    const shell = els.get('logsView')!.innerHTML;
    expect(shell).toContain('Only matching lines');
    expect(shell).not.toContain('> Filter<');
  });
});
