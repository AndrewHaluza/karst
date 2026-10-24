/**
 * React-view guards for the resources app (R-X5/R-X6/R-X7), as STATIC checks over
 * its source: no inline style or raw HTML, no imperative DOM or unstable keys, no
 * raw form controls or design-system primitive classes outside the shared
 * primitives, and no hand-rolled async state (a host verb goes through
 * `useHostAction`). Every banned pattern is shown to fire on a known-bad fixture,
 * so a loosened regex fails here instead of silently passing the app.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // …/src/ui/resources/app
const ROOT = join(HERE, '..', '..', '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const stripBlockComments = (text: string): string => text.replace(/\/\*.*?\*\//gs, '');
const rel = (file: string): string => relative(ROOT, file);
const isTest = (file: string): boolean => /\.test\.(ts|tsx)$/.test(file) || file.endsWith('renderResourcesApp.ts');
const APP_SOURCE = walk(HERE).filter((file) => !isTest(file));

type Banned = ReadonlyArray<readonly [name: string, pattern: RegExp, fixture: string]>;

function expectNoneBanned(banned: Banned): void {
  for (const [name, pattern, fixture] of banned) {
    expect(pattern.test(stripBlockComments(fixture)), `"${name}" cannot catch its own fixture`).toBe(true);
  }
  for (const file of APP_SOURCE) {
    const text = stripBlockComments(readFileSync(file, 'utf8'));
    for (const [name, pattern] of banned) {
      expect(pattern.test(text), `${name} in ${rel(file)}`).toBe(false);
    }
  }
}

describe('non-vacuity', () => {
  it('walks a non-empty app source set that includes the entry and both panes', () => {
    const names = APP_SOURCE.map((f) => f.slice(HERE.length + 1));
    expect(names).toEqual(expect.arrayContaining(['main.tsx', 'App.tsx', 'ResourcesPane.tsx', 'ServersPane.tsx']));
  });
});

describe('R-X6 — no inline style, no raw HTML', () => {
  it('never reaches around React to set presentation', () => {
    expectNoneBanned([
      ['inline style prop', /style=\{\{/, 'const a = <div style={{ color: "red" }} />;'],
      ['imperative element style', /\.style\./, 'node.style.display = "none";'],
      ['setAttribute("style")', /setAttribute\(\s*['"]style['"]/, `node.setAttribute('style', 'x');`],
      ['innerHTML', /\binnerHTML\b/, 'node.innerHTML = markup;'],
      ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/, '<div dangerouslySetInnerHTML={{ __html: m }} />'],
    ]);
  });
});

describe('R-X5/R26/R09b — imperative DOM and unstable keys', () => {
  it('derives state and keys from props instead', () => {
    expectNoneBanned([
      ['array-index key', /key=\{\s*(?:i|index)\b/, 'const el = <li key={i}>{x}</li>;'],
      ['imperative aria', /setAttribute\(\s*['"]aria-/, `node.setAttribute('aria-expanded', 'true');`],
      ['document.querySelector', /document\.querySelector/, 'document.querySelector(".k-tab");'],
    ]);
  });
});

describe('R07/R08/R25 — controls and primitives have one owner', () => {
  it('uses no raw form control (the page has none)', () => {
    expectNoneBanned([['raw control', /<\s*(?:input|select|textarea)\b/, 'const el = <input value={v} />;']]);
  });

  it('emits no design-system primitive class itself — Button/IconButton/LiveRegion own them', () => {
    expectNoneBanned([['k- primitive class', /className=["'`{][^"'`}]*\bk-(?:btn|iconbtn|chip|status|switch|spinner)/, '<span className="k-btn k-btn--primary" />']]);
  });

  it('keeps async lifecycle state inside useHostAction / useHostMutation', () => {
    expectNoneBanned([['hand-rolled pending state', /const\s*\[\s*(?:pending|loading)\w*\s*,/, 'const [pendingSave, setPendingSave] = useState(false);']]);
  });

  it('acquires the VS Code API exactly once, in the entry', () => {
    const callers = APP_SOURCE.filter((f) => /\bacquireVsCodeApi\s*\(/.test(stripBlockComments(readFileSync(f, 'utf8'))));
    expect(callers.map((f) => f.slice(HERE.length + 1))).toEqual(['main.tsx']);
  });

  it('posts only through the typed sender — no hand-written message object', () => {
    expectNoneBanned([['raw postMessage', /\.postMessage\(\s*\{/, 'api.postMessage({ type: "kill-server" });']]);
  });
});
