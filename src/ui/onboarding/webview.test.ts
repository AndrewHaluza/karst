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
 * Text-level guards on the onboarding webview (§ manual ticket creation, §
 * fetch-on-Enter). Standalone HTML with no test harness — same rationale as
 * dashboard/webview.test.ts: every DECISION here is host-agnostic script logic
 * that these regex checks can pin, even though nothing actually renders a DOM.
 */
describe('onboarding webview.html', () => {
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
    expect(HTML).toContain('id="providerSelect"');
    expect(HTML).toContain('id="providerLockHint"');
  });

  it('locks the provider picker while a session is open, mirroring the model picker', () => {
    const fnMatch = HTML.match(/function renderProviderPicker\([^)]*\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'renderProviderPicker() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("el('providerSelect').disabled = !!sessionOpen");
  });

  it('posts set-provider on change and carries agentProvider into submit/save', () => {
    expect(HTML).toContain("post({ type: 'set-provider', id });");
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
    expect(html).toMatch(/<button[^>]*class="attachdetach"[^>]*data-attach-id="7"/);
    expect(html).toMatch(/<button[^>]*class="attachopen"[^>]*data-attach-id="7"/);
    expect(html).toContain('aria-label="Open a.png"');
  });

  it('carries the video row id on its media, detach control, and explicit open control', () => {
    const html = render([
      { id: 8, kind: 'video', name: 'b.mov', byteSize: 1, src: 'webview://b.mp4' },
    ]);
    expect(html).toMatch(/<video[^>]*data-attach-id="8"/);
    expect(html).toMatch(/<button[^>]*class="attachdetach"[^>]*data-attach-id="8"/);
    expect(html).toMatch(/<button[^>]*class="attachopen"[^>]*data-attach-id="8"/);
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
