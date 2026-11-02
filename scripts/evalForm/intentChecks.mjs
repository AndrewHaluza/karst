// Deterministic checks for the ticket-form intent eval. generateIntent is never changed: adapter calls are counted from outside.

export const MIN_TEST_TITLE_LENGTH = 12; // shorter titles match by coincidence
const PATHLIKE = /(?:\b[\w.-]+\/[\w./-]+\b|\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|vue|snap)\b)/;
const API_IDENT = /`[^`\n]+`|\b[a-z]+[A-Z]\w*\b|\b\w+\(\)/g; // info only: for a library the API is the observable surface

/** Wrap an adapter so generateIntent's adapter calls can be counted (1 = first try, 2 = after the nudge). */
export function countCalls(adapter) {
  const state = { n: 0 };
  return {
    state,
    adapter: new Proxy(adapter, {
      get(t, p) {
        if (p !== 'runHeadless') return Reflect.get(t, p);
        return (opts) => { state.n += 1; return t.runHeadless(opts); };
      },
    }),
  };
}

export function parseOutcome({ text, degraded }, calls) {
  if (degraded || text === null) return 'degraded';
  return calls <= 1 ? 'first-try' : 'nudged';
}

export const scenarioLines = (text) =>
  (text.split(/^## Scenarios[ \t]*$/m)[1] ?? '').split(/^## /m)[0].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));

const testFile = (t) => t.split(' > ')[0];
const testTitle = (t) => t.split(' > ').at(-1);

/** F2P file paths or test titles appearing in the charter = leak flag (the guard should make this impossible). */
export function findLeaks(text, f2p) {
  const lower = text.toLowerCase();
  const leaks = [];
  for (const t of f2p) {
    const file = testFile(t);
    const base = file.split('/').at(-1);
    if (text.includes(file) || (base && text.includes(base))) leaks.push(`file: ${file}`);
    const title = testTitle(t);
    if (title.length >= MIN_TEST_TITLE_LENGTH && lower.includes(title.toLowerCase())) leaks.push(`test: ${title}`);
  }
  return [...new Set(leaks)];
}

/** Checks on one charter. `text` null (degraded) yields only the outcome. */
export function checkCharter({ result, calls, f2p = [] }) {
  const outcome = parseOutcome(result, calls);
  if (outcome === 'degraded') return { outcome, scenarios: 0, nonGwt: 0, pathTokens: [], leaks: [], apiIdentifiers: [] };
  const lines = scenarioLines(result.text);
  const nonGwt = lines.filter((l) => !(/\bgiven\b/i.test(l) && /\bwhen\b/i.test(l) && /\bthen\b/i.test(l))).length;
  return {
    outcome, scenarios: lines.length, nonGwt,
    pathTokens: result.text.split(/\s+/).filter((w) => PATHLIKE.test(w)),
    leaks: findLeaks(result.text, f2p),
    apiIdentifiers: [...new Set(result.text.match(API_IDENT) ?? [])],
  };
}

/** Split a unified diff into per-file sections keyed by path (b/ side). */
export function splitDiff(patch) {
  const files = new Map();
  for (const sec of patch.split(/^diff --git /m).slice(1)) {
    const m = sec.match(/^a\/\S+ b\/(\S+)/);
    if (m) files.set(m[1], sec);
  }
  return files;
}

export const MAX_HUNK_CHARS = 3000;

/** The test_patch part for one F2P test: hunks of its file that mention its title, else the file's diff head. */
export function hunkForTest(patch, test) {
  const sec = splitDiff(patch).get(testFile(test));
  if (!sec) return '(no hunk found in test_patch)';
  const hunks = sec.split(/^(?=@@ )/m);
  const header = hunks[0];
  const title = testTitle(test);
  const hit = hunks.slice(1).filter((h) => h.includes(title));
  const body = hit.length ? hit.join('') : hunks.slice(1).join('');
  return `${header}${body}`.slice(0, MAX_HUNK_CHARS);
}
