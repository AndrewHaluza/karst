import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

/**
 * Source-contract guards for the standalone ticket-changes webview.
 *
 * Git inspection, target resolution, and message validation live in the host.
 * These deliberately narrow assertions cover only the HTML's observable
 * hierarchy and its two-message protocol; runtime host behavior is tested in
 * panel.test.ts.
 */
describe('ticket changes webview.html', () => {
  it('renders Commits, Staged Changes, Changes, and Untracked Files', () => {
    for (const label of ['COMMITS', 'STAGED CHANGES', 'CHANGES', 'UNTRACKED FILES']) {
      expect(HTML).toContain(label);
    }
  });

  it('posts opaque changeId values and never posts a path or revision', () => {
    expect(HTML).toContain('data-change-id="${esc(file.changeId)}"');
    expect(HTML).toContain("vscode.postMessage({ type: 'open-diff', changeId: row.dataset.changeId })");
    expect(HTML).not.toMatch(/postMessage\(\{[^}]*\b(?:path|oldPath|revision|hash)\s*:/);
  });

  it('uses details/summary controls for keyboard-accessible repository and commit expansion', () => {
    expect(HTML).toMatch(/<details class="repo"/);
    expect(HTML).toMatch(/<details class="commit"/);
    expect(HTML).toMatch(/<summary><span><strong>/);
    expect(HTML).toMatch(/<summary><code>/);
  });

  it('filters by repository, commit hash/message, and file path locally', () => {
    expect(HTML).toContain('[worktree.label, worktree.branch, worktree.baseRef]');
    expect(HTML).toContain('[commit.hash, commit.shortHash, commit.subject, commit.author]');
    expect(HTML).toContain('includes(file.path, needle) || includes(file.oldPath, needle)');
    expect(HTML).toMatch(/filter\.addEventListener\('input',\s*\(\) => render\(lastState/);
    expect(HTML).not.toMatch(/filter\.addEventListener\('input',[\s\S]{0,160}postMessage/);
  });

  it('renders repository errors without replacing successful repositories', () => {
    expect(HTML).toContain('if (worktree.error)');
    expect(HTML).toContain('<section class="repo error">');
    expect(HTML).toContain('visible.map(worktreeRow).join');
  });

  it('keeps the prior state visible while loading', () => {
    expect(HTML).toMatch(/lastState\s*=\s*state/);
    expect(HTML).toContain('render(msg.state || lastState, true)');
    expect(HTML).toMatch(/vscode\.setState\(/);
  });
});
