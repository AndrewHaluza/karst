import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from './claude.js';
import { transcriptPathFor } from './claudeTranscriptWatch.js';

const SESSION = '5622173c-0000-4000-8000-000000000000';
const CWD = '/work/.karst/worktrees/some-ticket';

describe('ClaudeAdapter.resolveResume', () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  function setup(): { projects: string; debug: Mock<(m: string) => void> } {
    dir = mkdtempSync(join(tmpdir(), 'karst-resume-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    return { projects: join(dir, 'projects'), debug: vi.fn<(m: string) => void>() };
  }

  it('drops the id and logs when the transcript is missing', async () => {
    const { debug } = setup();
    const out = await new ClaudeAdapter().resolveResume(SESSION, { cwd: CWD, debug });
    expect(out).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('resume-transcript-missing'));
  });

  it('keeps the id when the transcript exists', async () => {
    const { projects, debug } = setup();
    const file = transcriptPathFor(projects, CWD, SESSION);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{}\n');
    expect(await new ClaudeAdapter().resolveResume(SESSION, { cwd: CWD, debug })).toBe(SESSION);
  });

  it('keeps the id and logs the error when the check fails for another reason', async () => {
    const { projects, debug } = setup();
    writeFileSync(projects, 'not a dir'); // ENOTDIR on stat
    expect(await new ClaudeAdapter().resolveResume(SESSION, { cwd: CWD, debug })).toBe(SESSION);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('transcript check failed'));
  });
});
