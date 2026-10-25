/**
 * Guards for the sidebar React app, as STATIC checks over its source:
 * `main.tsx` is the one `acquireVsCodeApi()` caller (VS Code throws on a second),
 * and the bundle imports no host module at runtime (a value import of the store,
 * the workflow or `vscode` would drag the extension host into a webview).
 * Trusted markup is injected through exactly one file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function sources(): string[] {
  return readdirSync(HERE)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && f !== 'renderSidebarApp.ts')
    .map((f) => join(HERE, f));
}
/** Source with comments removed, so prose mentioning an API is not a call to it. */
const code = (path: string): string => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const text = (path: string): string => readFileSync(path, 'utf8');
const name = (path: string): string => relative(HERE, path);

describe('sidebar app architecture', () => {
  it('finds the app sources', () => {
    expect(sources().length).toBeGreaterThan(10);
  });

  it('acquires the VS Code API in main.tsx only', () => {
    const callers = sources().filter((p) => /acquireVsCodeApi\s*\(/.test(code(p))).map(name);
    expect(callers).toEqual(['main.tsx']);
  });

  it('imports no host module at runtime — type-only imports from the host side are fine', () => {
    const offenders: string[] = [];
    for (const path of sources()) {
      for (const m of code(path).matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.\.\/[^']+|vscode|node:[^']+)'/gm)) {
        offenders.push(`${name(path)} → ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps raw HTML to the icon / agent-identity islands in Icon.tsx', () => {
    const users = sources().filter((p) => /dangerouslySetInnerHTML|innerHTML/.test(code(p))).map(name);
    expect(users).toEqual(['Icon.tsx']);
  });

  it('keeps every file under the size budget', () => {
    for (const path of sources()) expect(text(path).split('\n').length, name(path)).toBeLessThan(400);
  });

  it('shows the import rule fires on a known-bad line', () => {
    const bad = "import { listTickets } from '../../store/tickets.js';\nimport type { SidebarState } from '../state.js';\n";
    const hits = [...bad.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.\.\/[^']+|vscode|node:[^']+)'/gm)];
    expect(hits.map((m) => m[1])).toEqual(['../../store/tickets.js']);
  });
});
