import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellCommand } from './ciActionsWiring.js';

describe('runShellCommand', () => {
  it('runs in the given cwd and reports success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-shell-'));
    try {
      expect(await runShellCommand(dir, 'echo hi > out.txt')).toEqual({ code: 0, stderr: '' });
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hi\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('passes through the exit code and stderr of a failing command', async () => {
    const r = await runShellCommand(tmpdir(), 'echo oops >&2; exit 3');
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('oops\n');
  });
  it('treats a spawn failure as code 1', async () => {
    const r = await runShellCommand('/definitely/not/a/dir', 'true');
    expect(r.code).toBe(1);
  });
});
