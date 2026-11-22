import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(css|html|tsx)$/.test(name) && !/\.test\.|__snapshots__/.test(full)) out.push(full);
  }
  return out;
}

describe('light input edge (SET-57, C5)', () => {
  it('every border drawn from --vscode-input-border goes through --k-input-edge first', () => {
    // Light Modern's input border is 1.57:1 on white. Only the light-theme --k-input-edge
    // (designComponents.webview.css) reaches 3:1, so a bare use skips it.
    const bare = /border(?:-color)?:[^;}]*?(?<!--k-input-edge, )var\(--vscode-input-border/;
    const hits = walk(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => (bare.test(line) ? `${relative(SRC, f)}:${i + 1}` : null))
        .filter((h): h is string => h !== null),
    );
    expect(hits).toEqual([]);
  });
});
