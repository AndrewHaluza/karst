import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// D641/D642: every person-facing outcome is one karst_events row. The row is written by the two
// host seams, so a direct call that skips them would be a toast or a result the Activity feed never sees.
const SRC = join(__dirname, '..');
const TOAST_SEAM = 'extension/toastSeam.ts';
const RESULT_SEAM = 'model/actionResult.ts';

// Webview app code and its fixtures only simulate the host-to-webview message; they never post it.
const WEBVIEW_APP = /^ui\/[^/]+\/app\//u;

const DIRECT_TOAST = /vscode\.window\s*\.\s*show(Information|Warning|Error)Message\s*\(/u;
const DIRECT_RESULT_POST = /type:\s*['"]action-result['"]/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !/\.(test|spec)\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function offenders(pattern: RegExp, allowed: string): string[] {
  return sourceFiles(SRC)
    .map((file) => ({ rel: relative(SRC, file).split('\\').join('/'), text: readFileSync(file, 'utf8') }))
    .filter(({ rel, text }) => rel !== allowed && !WEBVIEW_APP.test(rel) && pattern.test(text))
    .map(({ rel }) => rel);
}

describe('the host seams of D641', () => {
  it('shows no VS Code message outside toastSeam.ts: use `toast` (recorded) or `ask` (a choice, not recorded)', () => {
    expect(offenders(DIRECT_TOAST, TOAST_SEAM)).toEqual([]);
  });

  it('posts no literal action-result outside actionResult.ts: use postActionResult or reportAction', () => {
    expect(offenders(DIRECT_RESULT_POST, RESULT_SEAM)).toEqual([]);
  });

  it('detects a direct call in the pattern itself', () => {
    expect(DIRECT_TOAST.test('void vscode.window\n  .showWarningMessage("x")')).toBe(true);
    expect(DIRECT_RESULT_POST.test("post({ type: 'action-result', requestId })")).toBe(true);
  });
});
