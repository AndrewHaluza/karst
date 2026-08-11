import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { slugifyTitleKey, TITLE_KEY_MAX } from '../../store/titleKey.js';
import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

function functionSource(name: string): string {
  const start = HTML.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found`);
  const bodyStart = HTML.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    if (HTML[i] === '}') depth -= 1;
    if (depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`${name}() is incomplete`);
}

function loadFunction(
  name: string,
  sandbox: Record<string, unknown> = {},
): (...args: unknown[]) => unknown {
  return runInNewContext(`(${functionSource(name)})`, {
    esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c),
    ...sandbox,
  }) as (...args: unknown[]) => unknown;
}

/** The page's own copy of a `const NAME = <number>;` declaration. */
function htmlConstNumber(name: string): number {
  const m = HTML.match(new RegExp(`const ${name} = (\\d+);`));
  if (!m) throw new Error(`${name} not found in the page`);
  return Number(m[1]);
}

/**
 * Text-level guards on the ticket-form webview (§ manual ticket creation, §
 * fetch-on-Enter). Standalone HTML with no test harness — same rationale as
 * dashboard/webview.test.ts: every DECISION here is host-agnostic script logic
 * that these regex checks can pin, even though nothing actually renders a DOM.
 */
describe('ticket-form webview.html', () => {
  it('gates Phase 2 on the title alone, whatever the provider — the key is never required', () => {
    // The literal bug (869echhyr): typing a title without clicking Fetch left
    // Phase 2 hidden on any board-backed provider, because phase1Valid()
    // required el('ref').value there. A manually entered ticket derives its key
    // from the title, so the key gates nothing for anyone now.
    const fnMatch = HTML.match(/function phase1Valid\(\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'phase1Valid() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).not.toContain("el('ref')");
    expect(body).toMatch(/return .*title.*trim\(\) !== ''/);
  });

  it('tracks the current provider so the fetch affordance can read it', () => {
    expect(HTML).toContain('let currentProvider');
    expect(HTML).toContain('currentProvider = p;'); // set from renderProvider(state.provider)
  });

  it('requires only a title on submit/save — a blank key is derived at persist time', () => {
    const submitBlock = HTML.slice(HTML.indexOf("el('submitBtn').addEventListener"));
    const saveBlock = HTML.slice(HTML.indexOf("el('saveBtn').addEventListener"));
    for (const block of [submitBlock, saveBlock]) {
      const head = block.slice(0, 600);
      expect(head).toContain('if (!title)');
      expect(head).toContain("showErr('Title is required.')");
      expect(head).not.toContain('!key');
    }
  });

  it('previews the derived key with the exact rule the store persists', () => {
    // The webview cannot import TS, so deriveKey() mirrors slugifyTitleKey().
    // Pin the mirror — a drift means the key you watched appear while typing is
    // not the key that lands in the DB.
    expect(htmlConstNumber('TITLE_KEY_MAX')).toBe(TITLE_KEY_MAX);
    const deriveKey = loadFunction('deriveKey', { TITLE_KEY_MAX }) as (t: string) => string;
    for (const title of [
      'Fix login redirect',
      '  [FIX] on  ticket/creation — key! ',
      'Bump vite 5 to 6',
      'On ticket creation when no fetch clicked it does not open the rest of the view',
      '—— ***',
      '',
    ]) {
      expect(deriveKey(title), `mirror drift for ${JSON.stringify(title)}`)
        .toBe(slugifyTitleKey(title));
    }
  });

  it('fills the key field from the title only while the user has not touched it', () => {
    const titleInput = HTML.match(
      /el\('title'\)\.addEventListener\('input', \(\) => {([\s\S]*?)\n {2}}\);/,
    );
    expect(titleInput, 'title input listener not found').toBeTruthy();
    expect(titleInput![1]).toContain('if (!refTouched)');
    expect(titleInput![1]).toContain('deriveKey(');
    // Typing (or clearing) the key field itself owns the field from then on.
    const refInput = HTML.match(
      /el\('ref'\)\.addEventListener\('input', \(\) => {([\s\S]*?)\n {2}}\);/,
    );
    expect(refInput, 'ref input listener not found').toBeTruthy();
    expect(refInput![1]).toContain('refTouched =');
  });

  it('fires the same fetch action on Enter in the key field as on the Fetch button click', () => {
    expect(HTML).toContain("el('fetchBtn').addEventListener('click', doFetch)");
    const refKeydown = HTML.match(/el\('ref'\)\.addEventListener\('keydown', \(e\) => {([\s\S]*?)}\);/);
    expect(refKeydown, "ref keydown listener not found").toBeTruthy();
    expect(refKeydown![1]).toContain("e.key !== 'Enter'");
    expect(refKeydown![1]).toContain('doFetch()');
  });

  it('the analyzer result badges the approach but never moves the pick', () => {
    // The AI approach is a suggestion: it sets aiSuggestion (the row badge) but
    // must NOT assign draft.approach, or an AI pick silently replaces the user's
    // explicit selection — which then gets persisted on the next save. The user's
    // selection is authoritative. See ticket 869e889uh.
    const caseMatch = HTML.match(/case 'analysis': {([\s\S]*?)\n {6}}/);
    expect(caseMatch, "analysis message handler not found").toBeTruthy();
    const body = caseMatch![1]!;
    expect(body).toContain('aiSuggestion =');
    expect(body).not.toMatch(/draft\.approach\s*=/);
  });

  it('doFetch is a no-op when the fetch button is hidden or already busy/done', () => {
    const fnMatch = HTML.match(/function doFetch\(\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'doFetch() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("classList.contains('hidden')");
    expect(body).toContain('disabled');
  });

  it('keeps an absent saved ticket model visible as an escaped saved option', () => {
    const renderModelOptions = loadFunction('renderModelOptions');
    const html = renderModelOptions(
      [{ id: 'current', label: 'Current', providers: ['codex'] }],
      'preview-<next>',
      null,
    ) as string;
    expect(html).toContain('value="preview-&lt;next&gt;" selected');
    expect(html).toContain('Saved model: preview-&lt;next&gt;');
  });

  it('renders an agent-core (provider) picker next to the model picker', () => {
    expect(HTML).toContain('id="agentSelectWrap"');
    expect(HTML).toContain('id="agentTrigger"');
    expect(HTML).toContain('id="providerLockHint"');
  });

  it('locks the provider picker while a session is open, mirroring the model picker', () => {
    const fnMatch = HTML.match(/function renderProviderPicker\([^)]*\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'renderProviderPicker() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("el('agentTrigger').disabled = !!sessionOpen");
  });

  it('posts set-provider on change and carries agentProvider into submit/save', () => {
    expect(HTML).toMatch(/post\(\{\s*type:\s*'set-provider'/);
    const submitBlock = HTML.slice(
      HTML.indexOf("el('submitBtn').addEventListener"),
      HTML.indexOf("el('saveBtn').addEventListener"),
    );
    expect(submitBlock).toContain('agentProvider');
    const saveBlock = HTML.slice(HTML.indexOf("el('saveBtn').addEventListener"));
    expect(saveBlock.slice(0, 800)).toContain('agentProvider');
  });

  // The pull switch (§ scope): ON by default, and the value the user left it on
  // is what submit carries. Save carries none — it launches nothing, so there is
  // no base to branch from and no choice to honor.
  it('ships the pull switch on by default and carries the live value into submit only', () => {
    const markup = HTML.slice(HTML.indexOf('id="pullBase"') - 400, HTML.indexOf('id="pullBase"') + 400);
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"'); // default ON
    expect(HTML).toMatch(/let pullBaseOn = true;/);

    const submitBlock = HTML.slice(
      HTML.indexOf("el('submitBtn').addEventListener"),
      HTML.indexOf("el('saveBtn').addEventListener"),
    );
    expect(submitBlock).toContain('pullBase: pullBaseOn');
    const saveBlock = HTML.slice(HTML.indexOf("el('saveBtn').addEventListener"));
    expect(saveBlock.slice(0, 1200)).not.toContain('pullBase');
  });
});

// ---- ticket search (the Key field's dropdown) ----
// The feature's DECISIONS are host-agnostic script logic: the popup is a
// combobox, results are escaped provider prose, the filter defaults to TODO
// and corrects itself to the list's real statuses. Pin them at text level.
describe('ticket-form webview.html — ticket search', () => {
  it('turns the key field into a combobox with a status filter defaulting to to do', () => {
    const refMarkup = HTML.slice(HTML.indexOf('id="ref"'), HTML.indexOf('id="ref"') + 400);
    expect(refMarkup).toContain('role="combobox"');
    expect(refMarkup).toContain('aria-autocomplete="list"');
    expect(refMarkup).toContain('aria-expanded="false"');
    expect(refMarkup).toContain('aria-controls="searchMenu"');
    const filter = HTML.slice(HTML.indexOf('id="searchFilterRow"'), HTML.indexOf('id="searchFilterRow"') + 400);
    expect(filter).toContain('id="searchStatus"');
    expect(filter).toContain('<option value="to do" selected>to do</option>'); // TODO default
    expect(HTML).toContain('id="searchMenu"');
  });

  it('renders search results as escaped listbox options (provider prose, UI-R32)', () => {
    const state = { innerHTML: '' };
    const opened: boolean[] = [];
    const renderSearchMenu = loadFunction('renderSearchMenu', {
      el: (id: string) => (id === 'searchMenu' ? state : null),
      openSearchMenu: () => opened.push(true),
    });
    renderSearchMenu('results', [
      { ref: 'CU-1', title: 'Fix <login> & "pay"', status: 'to do', priority: 'urgent' },
      { ref: 'CU-2', title: 'Plain', status: 'in review' },
    ]);
    expect(opened).toHaveLength(1);
    expect(state.innerHTML).toContain('role="option"');
    expect(state.innerHTML).toContain('data-ref="CU-1"');
    expect(state.innerHTML).not.toContain('<login>');
    expect(state.innerHTML).toContain('Fix &lt;login&gt; &amp; &quot;pay&quot;');
    expect(state.innerHTML).toContain('urgent');
    expect(state.innerHTML).toContain('to do');
  });

  it('renders the hint/searching/error/empty states of the popup', () => {
    const state = { innerHTML: '' };
    const renderSearchMenu = loadFunction('renderSearchMenu', {
      el: () => state,
      openSearchMenu: () => {},
    });
    renderSearchMenu('hint');
    expect(state.innerHTML).toContain('Type at least 2 characters');
    renderSearchMenu('searching');
    expect(state.innerHTML).toContain('Searching');
    renderSearchMenu('error', 'boom');
    expect(state.innerHTML).toContain('boom');
    renderSearchMenu('empty');
    expect(state.innerHTML).toContain('No tickets found');
  });

  it('never searches below 2 characters and never searches a derived key', () => {
    const currentSearchQuery = loadFunction('currentSearchQuery', {
      el: () => ({ value: 'a' }),
      SEARCH_MIN_CHARS: 2,
    });
    expect(currentSearchQuery()).toBe('');
    const full = loadFunction('currentSearchQuery', {
      el: () => ({ value: '  pay ' }),
      SEARCH_MIN_CHARS: 2,
    });
    expect(full()).toBe('pay');

    // scheduleSearch gates on refTouched — the derive-key preview is not a query.
    const schedule = functionSource('scheduleSearch');
    expect(schedule).toContain('!searchEnabled || !refTouched');
    expect(schedule).toContain('SEARCH_DEBOUNCE_MS');
    expect(schedule).toContain('runSearch');
    // The input listener schedules the search.
    const refInput = HTML.match(/el\('ref'\)\.addEventListener\('input', \(\) => \{([\s\S]*?)\n {2}}\);/);
    expect(refInput![1]).toContain('scheduleSearch()');
  });

  it('posts search-tickets with the live status filter and arms a watchdog', () => {
    const run = functionSource('runSearch');
    expect(run).toContain("post({ type: 'search-tickets', query, status })");
    expect(run).toContain("el('searchStatus').value");
    expect(run).toContain("setAttribute('aria-busy', 'true')");
    expect(run).toContain('KARST_WATCHDOG_MS'); // UI-R14: a hung host cannot leave it pending
    expect(run).toContain('Search timed out');
  });

  it('drops stale replies and settles only the in-flight request', () => {
    const results = HTML.match(/case 'ticket-search-results': \{([\s\S]*?)\n {6}}/);
    expect(results, 'ticket-search-results handler not found').toBeTruthy();
    const body = results![1]!;
    expect(body).toContain('searchPending');
    expect(body).toContain('msg.query !== searchPending.query || msg.status !== searchPending.status');
    const err = HTML.match(/case 'ticket-search-error': \{([\s\S]*?)\n {6}}/);
    expect(err![1]).toContain('searchPending');
  });

  it('picking a result fills the key, marks it touched, and fetches the brief', () => {
    const pick = functionSource('pickSearchResult');
    expect(pick).toContain("el('ref').value = ref;");
    expect(pick).toContain('refTouched = true;');
    expect(pick).toContain('closeSearchMenu()');
    expect(pick).toContain('doFetch()');
    // Enter with the popup open picks the focused option; otherwise plain fetch.
    const refKeydown = HTML.match(/el\('ref'\)\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n {2}}\);/);
    expect(refKeydown![1]).toContain('pickSearchResult(focused.dataset.ref)');
    expect(refKeydown![1]).toContain('doFetch()');
  });

  it('corrects the filter to the list statuses: TODO when present, else the first', () => {
    const makeSel = () => {
      const sel = { innerHTML: '', value: 'to do' };
      return sel;
    };
    let reruns = 0;
    const apply = loadFunction('applySearchStatuses', {
      el: () => sel,
      esc: (s: unknown) => String(s),
      currentSearchQuery: () => 'pay',
      runSearch: () => { reruns += 1; },
    });

    const sel = makeSel();
    apply(['to do', 'in progress', 'done']);
    expect(sel.value).toBe('to do'); // TODO default kept
    expect(sel.innerHTML).toContain('value="to do"');
    expect(reruns).toBe(0); // the default did not move — no re-run needed

    const sel2 = makeSel();
    const apply2 = loadFunction('applySearchStatuses', {
      el: () => sel2,
      esc: (s: unknown) => String(s),
      currentSearchQuery: () => 'pay',
      runSearch: () => { reruns += 1; },
    });
    apply2(['backlog', 'in review']);
    expect(sel2.value).toBe('backlog'); // no TODO → first status
    expect(reruns).toBe(1); // the filter moved — the open search re-runs under it
  });

  it('requests the provider statuses once, on the first search', () => {
    const fn = functionSource('requestSearchStatuses');
    expect(fn).toContain('searchStatusesRequested');
    expect(fn).toContain("post({ type: 'search-statuses' })");
    expect(functionSource('runSearch')).toContain('requestSearchStatuses()');
  });
});

describe('attachment strip', () => {
  const render = (list: unknown): string =>
    loadFunction('renderAttachments', {
      formatBytes: loadFunction('formatBytes'),
    })(list) as string;

  it('renders nothing when there are no attachments', () => {
    expect(render([]).trim()).toBe('');
  });

  it('renders an image tile with an img element pointing at the src', () => {
    const html = render([
      { id: 1, kind: 'image', name: 'login-error.png', byteSize: 4096, src: 'webview://a.png' },
    ]);
    expect(html).toContain('<img');
    expect(html).toContain('src="webview://a.png"');
    expect(html).toContain('login-error.png');
  });

  it('renders a video tile with a controllable video element', () => {
    const html = render([
      { id: 2, kind: 'video', name: 'repro.mov', byteSize: 1048576, src: 'webview://b.mp4' },
    ]);
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('src="webview://b.mp4"');
  });

  it('carries the image row id on its media, detach control, and explicit open control', () => {
    const html = render([
      { id: 7, kind: 'image', name: 'a.png', byteSize: 1, src: 'webview://a.png' },
    ]);
    expect(html).toMatch(/<img[^>]*data-attach-id="7"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\battachdetach\b[^"]*"[^>]*data-attach-id="7"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\battachopen\b[^"]*"[^>]*data-attach-id="7"/);
    expect(html).toContain('aria-label="Open a.png"');
  });

  it('carries the video row id on its media, detach control, and explicit open control', () => {
    const html = render([
      { id: 8, kind: 'video', name: 'b.mov', byteSize: 1, src: 'webview://b.mp4' },
    ]);
    expect(html).toMatch(/<video[^>]*data-attach-id="8"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\battachdetach\b[^"]*"[^>]*data-attach-id="8"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\battachopen\b[^"]*"[^>]*data-attach-id="8"/);
    expect(html).toContain('aria-label="Open b.mov"');
  });

  it('opens only from the explicit button so native video controls stay independent', () => {
    const handler = HTML.slice(
      HTML.indexOf("el('attachments').addEventListener('click'"),
      HTML.indexOf('// Clipboard images have no path'),
    );
    expect(handler).toContain("closest('.attachopen')");
    expect(handler).not.toContain("closest('video");
    expect(handler).not.toContain("closest('img");
  });

  // The strip renders values that came from a ticket the user did not author.
  // esc() is the primary defense; the CSP is only the backstop under it.
  it('escapes the original filename', () => {
    const html = render([
      {
        id: 1, kind: 'image', byteSize: 1, src: 'webview://a.png',
        name: '<img src=x onerror="alert(1)">.png',
      },
    ]);
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes the src', () => {
    const html = render([
      { id: 1, kind: 'image', name: 'a.png', byteSize: 1, src: 'x" onerror="alert(1)' },
    ]);
    expect(html).not.toContain('onerror="alert(1)"');
  });
});

describe('formatBytes', () => {
  const formatBytes = loadFunction('formatBytes') as (n: number) => string;

  it('renders bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
  });
});

// The host re-checks this. The page's copy exists so the user is told BEFORE a
// large paste crosses postMessage, not after the host silently drops it — so the
// two values must be the same number.
describe('paste cap mirror', () => {
  it('matches the host cap exactly', () => {
    expect(htmlConstNumber('MAX_PASTE_BYTES')).toBe(MAX_PASTE_BYTES);
  });
});

describe('pasted file reader', () => {
  function readerHarness() {
    const posted: unknown[] = [];
    const errors: string[] = [];
    let reader: {
      result: unknown;
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      readAsDataURL(file: unknown): void;
    } | undefined;
    class FakeFileReader {
      result: unknown = null;
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      constructor() {
        reader = this;
      }
      readAsDataURL(): void {}
    }
    const read = loadFunction('postPastedFile', {
      FileReader: FakeFileReader,
      MAX_PASTE_BYTES,
      post: (message: unknown) => posted.push(message),
      showErr: (message: string) => errors.push(message),
    }) as (file: { name: string; size: number }) => void;
    read({ name: 'broken.png', size: 4 });
    if (!reader) throw new Error('FileReader was not constructed');
    return { reader, posted, errors };
  }

  it.each(['onerror', 'onabort'] as const)('reports FileReader %s without posting bytes', (event) => {
    const harness = readerHarness();

    harness.reader[event]?.();

    expect(harness.errors).toEqual(['broken.png could not be read from the clipboard.']);
    expect(harness.posted).toEqual([]);
  });

  it.each([null, 'not-a-data-url', 'data:image/png;base64,'])(
    'reports malformed FileReader result %j without posting bytes',
    (result) => {
      const harness = readerHarness();
      harness.reader.result = result;

      harness.reader.onload?.();

      expect(harness.errors).toEqual(['broken.png could not be read from the clipboard.']);
      expect(harness.posted).toEqual([]);
    },
  );
});

// ── UI-RULES.md remediation guards (Task 3.5) ─────────────────────────────────

function styleBlocks(): string[] {
  const blocks: string[] = [];
  const re = /<style>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(HTML))) blocks.push(m[1]!);
  expect(blocks.length).toBeGreaterThanOrEqual(2); // the main <style> + the trailing palette <style>
  return blocks;
}

function scriptBlock(): string {
  const start = HTML.indexOf('<script>');
  const end = HTML.indexOf('</script>');
  expect(start, '<script> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</script> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<script>'.length, end);
}

describe('ticket-form webview.html — UI-RULES.md remediation', () => {
  it('carries the design-system markers ahead of any file-local rule (UI-R03)', () => {
    const [main] = styleBlocks();
    expect(main!.trimStart().startsWith('/*KARST_DS_CSS*/')).toBe(true);
    const script = scriptBlock();
    expect(script.trimStart().startsWith('/*KARST_DS_JS*/')).toBe(true);
  });

  it('contains no raw hex/rgb/px/rem style literal outside the injected tokens (UI-R04)', () => {
    const [main] = styleBlocks();
    const local = main!.slice(main!.indexOf('/*KARST_DS_CSS*/') + '/*KARST_DS_CSS*/'.length);
    const offenders = local.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b[0-9]+(\.[0-9]+)?(px|rem)\b/g);
    expect(offenders, JSON.stringify(offenders)).toBeNull();
  });

  it('carries no inline style="…" attribute in the markup (UI-R04 extends past the stylesheet)', () => {
    expect(HTML).not.toMatch(/\sstyle="/);
  });

  it('.ghost resolves to the real k-btn--ghost primitive, not a ruleless local class (UI-R10)', () => {
    expect(HTML).not.toMatch(/class="ghost"/);
    expect(HTML).toContain('id="attachBtn" class="k-btn k-btn--ghost"');
  });

  it('does not restyle a bare <button> — every button is a `.k-btn`/`.k-iconbtn`/`.k-switch` variant (UI-R07)', () => {
    const [main] = styleBlocks();
    expect(main).not.toMatch(/(^|\s)button\s*\{/);
    expect(main).not.toContain('button.secondary');
    expect(main).not.toContain('#fetchBtn.done{');
  });

  it('every <button> (static or templated) carries a k-btn/k-iconbtn/k-switch/k-chip/acard class (UI-R07)', () => {
    // Strip HTML comments, <style> blocks, and JS `//`/`/* */` comments first —
    // a doc comment describing markup (e.g. "a real <button role=…>") reads as
    // a bare `<button …>` tag to a naive regex otherwise.
    const withoutHtmlComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
    const withoutStyle = withoutHtmlComments.replace(/<style>[\s\S]*?<\/style>/g, '');
    const withoutBlockComments = withoutStyle.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
    const buttonTags = [...withoutLineComments.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    expect(buttonTags.length).toBeGreaterThan(0);
    for (const tag of buttonTags) {
      expect(tag, tag).toMatch(/class="[^"]*\b(k-btn|k-iconbtn|k-switch|k-chip|acard)\b/);
    }
  });

  it('#detailsBtn tracks its disclosure state via aria-expanded (UI-R26)', () => {
    expect(HTML).toContain('id="detailsBtn" aria-expanded="false"');
    const script = scriptBlock();
    expect(script).toContain("el('detailsBtn').setAttribute('aria-expanded', 'true');");
    expect(script).toContain("el('detailsBtn').setAttribute('aria-expanded', 'false');");
  });

  it('repo chips are real buttons carrying aria-pressed, not a bare role="button" span (UI-R09, R26)', () => {
    expect(HTML).not.toMatch(/role="button"\s+tabindex="0"\s+data-repo/);
    const script = scriptBlock();
    expect(script).toContain('class="k-chip repochip" data-repo="${esc(r.service)}" aria-pressed="${on}"');
  });

  it('the approach picker is a radiogroup of real buttons carrying aria-checked (UI-R09, R26)', () => {
    expect(HTML).toContain('id="approachList" role="radiogroup" aria-label="Approach"');
    const script = scriptBlock();
    expect(script).toContain('role="radio" aria-checked="${a.id===sel}" data-approach="${esc(a.id)}"');
    expect(script).not.toMatch(/class="acard[^"]*"\s+role="button"/);
  });

  it('the vertical stepper marks the current step with aria-current (UI-R26)', () => {
    const script = scriptBlock();
    const fnMatch = script.match(/function setStep\([^)]*\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'setStep() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("s.setAttribute('aria-current', 'step')");
    expect(body).toContain("s.removeAttribute('aria-current')");
  });

  it('the gate signal-word inputs carry an accessible name, not a placeholder alone (UI-R25)', () => {
    const script = scriptBlock();
    expect(script).toContain('aria-label="Signal words for ${esc(svc)}"');
  });

  it('every static input/select/textarea has a real <label for> or an aria-label (UI-R25)', () => {
    const ids = [...HTML.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([a-zA-Z-]+)"[^>]*>/g)]
      .map((m) => ({ tag: m[0], id: m[1]! }));
    expect(ids.length).toBeGreaterThan(0);
    for (const { tag, id } of ids) {
      const labeled = HTML.includes(`for="${id}"`) || /aria-label="/.test(tag);
      expect(labeled, `${id} has neither a <label for> nor an aria-label`).toBe(true);
    }
  });

  it('marks the Title field invalid (and clears it) instead of only the global banner (UI-R25)', () => {
    const script = scriptBlock();
    expect(script).toContain('function setTitleInvalid(invalid)');
    expect(script).toContain("input.setAttribute('aria-invalid', 'true')");
    expect(script).toContain("input.setAttribute('aria-describedby', 'err')");
    // Called from both submit and save validation, and cleared on a valid retry.
    const submitBlock = HTML.slice(HTML.indexOf("el('submitBtn').addEventListener"), HTML.indexOf("el('saveBtn').addEventListener"));
    expect(submitBlock).toContain('setTitleInvalid(true)');
    expect(submitBlock).toContain('setTitleInvalid(false)');
  });

  it('#err is an announced region (role=alert) and the toast root is the one status live region (UI-R27)', () => {
    expect(HTML).toContain('id="err" role="alert"');
  });

  it('the destructive attachment control uses the danger icon-button variant with a matching aria-label (UI-R10b, R21, R24)', () => {
    const script = scriptBlock();
    expect(script).toContain('k-iconbtn k-iconbtn--danger attachdetach');
    expect(script).toContain('aria-label="Remove attachment" title="Remove attachment"');
  });

  it('async controls report pending via the shared runtime rather than swapping their label (UI-R11, R18)', () => {
    const script = scriptBlock();
    // attach-pick / attach-bytes / detach-attachment / open-attachment.
    expect(script).toContain("karstAction(el('attachBtn'), (requestId) => post({ type: 'attach-pick', requestId }));");
    expect(script).toContain('karstBeginPending(detach, requestId);');
    expect(script).toContain('karstBeginPending(open, requestId);');
    expect(script).toContain('karstBeginPending(el(\'attachBtn\'), requestId);');
    // set-repos / set-approach / set-agent / set-model / set-provider / set-type.
    expect(script).toContain("post({ type: 'set-repos', repos, requestId });");
    expect(script).toContain("post({ type: 'set-approach', id, requestId });");
    expect(script).toContain("post({ type: 'set-agent', id, requestId });");
    expect(script).toContain("post({ type: 'set-model', id, requestId });");
    expect(script).toMatch(/post\(\{\s*type:\s*'set-provider'/);
    expect(script).toContain("post({ type: 'set-type', id, requestId });");
  });

  it('handles action-result by settling the pending control (UI-R13)', () => {
    const script = scriptBlock();
    expect(script).toContain("case 'action-result': karstSettle(msg.requestId, msg.ok, msg.message); break;");
  });

  it('no control mutates a button label while pending — setSubmitBusy/setSaveBusy/setFetchState never touch textContent (UI-R18)', () => {
    const script = scriptBlock();
    for (const fnName of ['setSubmitBusy', 'setSaveBusy', 'setFetchState']) {
      const fnMatch = script.match(new RegExp(`function ${fnName}\\([^)]*\\)\\s*{([\\s\\S]*?)\\n {2}}`));
      expect(fnMatch, `${fnName}() not found`).toBeTruthy();
      const body = fnMatch![1]!;
      expect(body, `${fnName} touches textContent`).not.toContain('textContent');
      expect(body, `${fnName} touches innerHTML`).not.toContain('innerHTML');
    }
    // render() only ever sets the submit label OUTSIDE a busy window.
    expect(script).toContain("if (!submitBusy) el('submitBtn').textContent = submitLabel;");
  });

  /**
   * The Prefill button already carries its pending state the way every other
   * control does — `aria-busy` plus the primitive's own spinner (UI-R11/R18).
   * The `analyzing…` note beside it was a SECOND rendering of that one state,
   * so the toolbar read "⟳ Prefill analyzing…" and the row reflowed as the
   * word appeared and vanished. One state, one expression.
   */
  it('states the analyze pending once, on the button, with no second note beside it', () => {
    // Rendered text, not the source: the comment that records the defect is
    // allowed to name it.
    expect(HTML, 'the note is still rendered').not.toMatch(/>\s*analyzing/i);
    expect(HTML, 'the note element survives').not.toContain('analyzeBusy');
    expect(HTML, 'analyze no longer marks the button busy').toContain(
      "el('analyzeBtn').setAttribute('aria-busy', 'true')",
    );
  });

  it('the busy vocabulary is closed and every member (including "suggest") is handled (UI-R16)', () => {
    const script = scriptBlock();
    const fnMatch = script.match(/function setBusy\([^)]*\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'setBusy() not found').toBeTruthy();
    const body = fnMatch![1]!;
    for (const what of ['fetch', 'submit', 'save', 'suggest', 'analyze', 'provider-ticket']) {
      expect(body, `setBusy has no '${what}' case`).toContain(`what === '${what}'`);
    }
  });

  /**
   * The provider-task control (869e9xq5y-fu1): a create-mode checkbox and an
   * edit-mode button, both hidden once the ticket is bound (no double-creation),
   * with the inline error rendered beside whichever control is visible.
   */
  it('renders the provider-task control by mode and hides it on a bound ticket', () => {
    const fnMatch = HTML.match(/function renderCreateIn\([^)]*\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'renderCreateIn() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("el('createInRow').classList.toggle('hidden', !showCheck);");
    expect(body).toContain("el('createInBtn').classList.toggle('hidden', !showBtn);");
    expect(body).toContain('state.mode === \'edit\' && !(state.sourceRef || \'\').trim()');
    expect(body).toContain('createInError');
  });

  it('the edit-mode button enters pending locally on click and posts create-provider-ticket', () => {
    const script = scriptBlock();
    expect(script).toContain("post({ type: 'create-provider-ticket' });");
    expect(script).toMatch(/el\('createInBtn'\)\.setAttribute\('aria-busy', 'true'\)/);
    expect(script).toMatch(/el\('createInBtn'\)\.disabled = true;/);
  });

  it('the create-mode checkbox rides submit and save as createInProvider (default off)', () => {
    const script = scriptBlock();
    expect(script).toContain('createInProvider: createInOn');
    expect(script).toContain("createInOn = !createInOn;");
  });

  it('handles provider-ticket-created and provider-ticket-error on the message channel', () => {
    const script = scriptBlock();
    expect(script).toContain("case 'provider-ticket-created':");
    expect(script).toContain("case 'provider-ticket-error':");
    // A failure resets the checkbox so a broken provider can never trap the
    // ticket at submit — the edit-mode button is the explicit retry.
    expect(script).toMatch(/case 'provider-ticket-error':[\s\S]*?createInOn = false/);
  });
});

describe('ticket-form webview.html — selects, buttons, positioning fixes', () => {
  it('defines --chevron so the agent-core trigger paints its dropdown arrow', () => {
    // The trigger's `.chev` uses var(--chevron) but the page never defined the
    // variable (settings does, in its own :root) — the custom select rendered
    // as a plain button with no affordance. The data URI is the one accepted
    // UI-R04 exception (a data-URI SVG cannot consume a custom property).
    expect(HTML).toMatch(/:root\{[^}]*--chevron:url\("data:image\/svg\+xml/);
  });

  it('strips the OS arrow from native selects and paints the shared chevron (UI-R04)', () => {
    // settings does this; the ticket form's selects (#agentSelect/#modelSelect/
    // #typeSelect/#searchStatus) kept the raw OS arrow, whose placement drifts
    // between platforms/renderers and reads as a different widget from the
    // custom Agent-core trigger beside them.
    const [main] = styleBlocks();
    const rule = main!.match(/select\.k-input\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('appearance:none;-webkit-appearance:none');
    expect(rule).toContain('background-image:var(--chevron)');
    expect(rule).toContain('padding-right:calc(var(--k-space-8) + var(--k-space-4))');
    expect(rule).toContain('background-position:right var(--k-space-5) center');
  });

  it('closes the agent-core menu and repaints the trigger on pick (create mode has no state push)', () => {
    // In create mode the host's set-provider is a no-op (no ticket to persist),
    // so nothing re-renders the trigger until submit — the pick must update the
    // trigger + option states and close the menu locally, exactly as settings'
    // selectAgent does. Before the fix the menu stayed open and the trigger
    // kept showing the previous core.
    const fnMatch = HTML.match(/function selectProvider\([^)]*\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'selectProvider() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("trigger.innerHTML = agentBadgeHtml(");
    expect(body).toContain("menu.classList.add('hidden')");
    expect(body).toContain("trigger.setAttribute('aria-expanded', 'false')");
    expect(body).toContain('aria-selected');
  });

  it('suppresses the k-btn press-scale and the pending/success flashes on the dropdown trigger', () => {
    // The trigger composes .k-btn (UI-R07), but it is a DROPDOWN control, not
    // an action button: the primitive's scale-on-active squishes it on every
    // menu open/close, its aria-busy spinner is injected into the flex row
    // (shifting the badge), and the settle flash turns it green with a check
    // — all on a widget whose pick repaints itself. Same call
    // designComponents.ts makes for .k-btn--row: a trigger is not a button.
    const [main] = styleBlocks();
    expect(main).toMatch(/\.agentselect-trigger:active:not\(:disabled\)\{[^}]*transform:none/);
    expect(main).toMatch(/\.agentselect-trigger\[aria-busy="true"\]::before\{[^}]*content:none/);
    expect(main).toMatch(/\.agentselect-trigger\.is-success[^{]*::before\{[^}]*content:none/);
  });

  it('re-renders the model picker for the picked provider from the last catalog', () => {
    // The Model select sits right below the agent-core picker and must follow
    // it. In create mode the host no-ops set-provider (no state push follows),
    // so selectProvider has to re-filter the models locally from the catalog
    // the state push carried — otherwise the Model select keeps the previous
    // agent core's models until the next full render.
    const fn = functionSource('selectProvider');
    expect(fn).toContain('renderModelPicker(');
    expect(fn).toContain('modelsForProvider(');
    expect(fn).toContain('lastDefaultProvider');
    // The cascade needs the pushed default + session lock to render honestly.
    const render = functionSource('render');
    expect(render).toContain('lastModelCatalog = state.modelCatalog');
    expect(render).toContain('lastDefaultModel = state.defaultModel');
  });

  it('Cancel closes the form instead of posting a dead request-state', () => {
    // requestState re-pushes state, and render() refuses to clobber non-empty
    // fields — so the old Cancel visibly did nothing in both modes. The panel
    // has its own close affordance; Cancel now means "discard and close".
    const start = HTML.indexOf("el('cancelBtn').addEventListener");
    const end = HTML.indexOf("el('analyzeBtn').addEventListener");
    const cancel = HTML.slice(start, end);
    expect(cancel).toContain("post({ type: 'close-form' })");
    expect(cancel).not.toContain('request-state');
  });

  it('styles the attach-row caption as a caption, not body text', () => {
    // The "or paste a screenshot into the prompt" hint had no rule at all, so
    // it rendered at full size/opacity while every other caption uses .sub.
    const [main] = styleBlocks();
    const rule = main!.match(/\.hint\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('font-size:var(--k-text-sm)');
    expect(rule).toContain('opacity:.6');
  });

  it('centres the step rail under the dots so the spine lines up with them', () => {
    // The dot is --k-space-9 (26px) wide → its centre sits 13px into the card.
    // margin-left:--k-space-5 (10px) put the 2px rail's centre at 11px — the
    // spine ran 2px left of every dot it joins. --k-space-6 (12px) centres it.
    const [main] = styleBlocks();
    const rule = main!.match(/\.stepbody\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('margin-left:var(--k-space-6)');
  });
});

describe('legacy busy channel watchdog', () => {
  /**
   * `fetch`/`suggest`/`submit`/`analyze`/`save` settle through the host's
   * `busy:false`, not through `action-result`, so the shared runtime's watchdog
   * never covered them: a host that never sent the closing half left the button
   * disabled forever (UI-R14).
   */
  it('arms a watchdog whenever a busy state is entered', () => {
    expect(HTML).toContain('function armBusyWatchdog(');
    expect(HTML).toMatch(/if \(on\) armBusyWatchdog\(what\); else clearBusyWatchdog\(what\);/);
  });

  it('reuses the runtime timeout rather than inventing a second one', () => {
    expect(HTML).toContain('KARST_WATCHDOG_MS');
  });

  it('reports the expiry as unknown, which is not a failure claim', () => {
    const at = HTML.indexOf('function armBusyWatchdog(');
    const body = HTML.slice(at, at + 600);
    expect(body).toMatch(/unknown/i);
    expect(body).not.toMatch(/\bfailed\b/i);
  });

  it('clears the pending state when the watchdog fires', () => {
    const at = HTML.indexOf('function armBusyWatchdog(');
    expect(HTML.slice(at, at + 600)).toContain('setBusy(what, false)');
  });
});
