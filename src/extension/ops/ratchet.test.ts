import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The number ratchets down as extractions land and is never raised. The
// value is the measured line count (8393) plus 3 lines of deliberate slack.
// The `parkUnavailable` extraction in `resumeFixSession` funded the fix-stall
// watchdog wiring. Anything larger than a thin binding belongs in
// `src/extension/ops/`.
const MAX_EXTENSION_LINES = 8396;

describe('extension.ts ratchet', () => {
  it('extension.ts does not exceed the recorded line count', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(MAX_EXTENSION_LINES);
  });
});

describe('ops/ has no vscode import', () => {
  it('no file under src/extension/ops/ imports vscode', () => {
    const opsDir = join(process.cwd(), 'src', 'extension', 'ops');
    const files = readdirSync(opsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const vscodeRe = /from ['"]vscode['"]|require\(['"]vscode['"]\)/;
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(opsDir, file), 'utf8');
      if (vscodeRe.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
