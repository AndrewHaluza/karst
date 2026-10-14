import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_STATUSLINE_WRAPPER } from './claudeStatusline.js';
import { readClaudeQuota } from './claude.js';
import { resolveNodeExecutable } from '../nodeExecutable.js';

/**
 * The statusline quota wrapper in a real node process: it caches the two
 * subscription windows the reader parses, and chains (or silences) the rendered
 * line. Spawns real node child processes → integration.
 */

const root = mkdtempSync(join(tmpdir(), 'karst-statusline-int-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NODE = resolveNodeExecutable();

function caseDir(): string {
  return mkdtempSync(join(root, 'case-'));
}

function writeWrapper(dir: string): string {
  const path = join(dir, 'statusline.cjs');
  writeFileSync(path, CLAUDE_STATUSLINE_WRAPPER);
  return path;
}

function runWrapper(
  wrapperPath: string,
  args: string[],
  input: string | Buffer,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [wrapperPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

function readCache(cachePath: string): unknown {
  return JSON.parse(readFileSync(cachePath, 'utf8'));
}

describe('CLAUDE_STATUSLINE_WRAPPER', () => {
  it('keeps ONLY the 5-hour and 7-day windows, atomically, and prints nothing with no chain', async () => {
    const dir = caseDir();
    const wrapper = writeWrapper(dir);
    const cachePath = join(dir, 'claude', 'cache', 'quota.json');
    const payload = JSON.stringify({
      model: { display_name: 'Claude Sonnet' },
      oauth_token: 'SECRET-TOKEN',
      context_window: { used_percentage: 22.4, context_window_size: 200_000 },
      rate_limits: {
        five_hour: { used_percentage: 34, resets_at: 1746540000 },
        seven_day: { used_percentage: 12, resets_at: 1746799200 },
      },
    });

    const res = await runWrapper(wrapper, [cachePath], payload);

    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    expect(readCache(cachePath)).toEqual({
      rate_limits: {
        five_hour: { used_percentage: 34, resets_at: 1746540000 },
        seven_day: { used_percentage: 12, resets_at: 1746799200 },
      },
    });
    // No payload/token leaked to the cache, and no temp file left behind.
    expect(readFileSync(cachePath, 'utf8')).not.toContain('SECRET-TOKEN');
    expect(readdirSync(join(dir, 'claude', 'cache'))).toEqual(['quota.json']);
  });

  it('writes no cache for a missing or malformed rate_limits', async () => {
    const dir = caseDir();
    const wrapper = writeWrapper(dir);
    const cachePath = join(dir, 'cache', 'quota.json');

    const missing = await runWrapper(wrapper, [cachePath], JSON.stringify({ model: {} }));
    expect(missing.code).toBe(0);
    expect(existsSync(cachePath)).toBe(false);

    const malformed = await runWrapper(wrapper, [cachePath], '{ not json');
    expect(malformed.code).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('drops a window whose used_percentage is not a number', async () => {
    const dir = caseDir();
    const wrapper = writeWrapper(dir);
    const cachePath = join(dir, 'cache', 'quota.json');
    await runWrapper(
      wrapper,
      [cachePath],
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 34, resets_at: 1746540000 },
          seven_day: { resets_at: 1746799200 },
        },
      }),
    );
    expect(readCache(cachePath)).toEqual({
      rate_limits: { five_hour: { used_percentage: 34, resets_at: 1746540000 } },
    });
  });

  it('declines an over-cap stdin without throwing or caching', async () => {
    const dir = caseDir();
    const wrapper = writeWrapper(dir);
    const cachePath = join(dir, 'cache', 'quota.json');
    const res = await runWrapper(wrapper, [cachePath], 'x'.repeat(300 * 1024));
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(existsSync(cachePath)).toBe(false);
  });

  it('chains the user statusline with the SAME stdin, stdout verbatim, cache still written', async () => {
    const dir = caseDir();
    const wrapper = writeWrapper(dir);
    const cachePath = join(dir, 'cache', 'quota.json');
    const passthrough = join(dir, 'passthrough.cjs');
    writeFileSync(passthrough, "let d='';process.stdin.on('data',(c)=>(d+=c));process.stdin.on('end',()=>process.stdout.write('RENDERED:'+d));");
    const chained = `${JSON.stringify(NODE)} ${JSON.stringify(passthrough)}`;
    const payload = JSON.stringify({
      rate_limits: { five_hour: { used_percentage: 7, resets_at: 1746540000 } },
    });

    const res = await runWrapper(wrapper, [cachePath, chained], payload);

    expect(res.code).toBe(0);
    // The rendered line is the chained command's stdout, byte-for-byte.
    expect(res.stdout).toBe(`RENDERED:${payload}`);
    expect(readCache(cachePath)).toEqual({
      rate_limits: { five_hour: { used_percentage: 7, resets_at: 1746540000 } },
    });
  });

  it('replaces an existing cache on the next turn', async () => {
    const dir = caseDir();
    const wrapper = writeWrapper(dir);
    const cachePath = join(dir, 'cache', 'quota.json');
    await runWrapper(
      wrapper,
      [cachePath],
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }),
    );
    await runWrapper(
      wrapper,
      [cachePath],
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 2 } } }),
    );
    expect(readCache(cachePath)).toEqual({
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 2 } },
    });
  });

  it('produces a cache the reader reads as ok (producer → reader contract)', async () => {
    const dir = caseDir();
    const configDir = join(dir, 'claude');
    const wrapper = writeWrapper(dir);
    const cachePath = join(configDir, 'cache', 'quota.json');
    await runWrapper(
      wrapper,
      [cachePath],
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 34, resets_at: 1746540000 },
          seven_day: { used_percentage: 12, resets_at: 1746799200 },
        },
      }),
    );
    const snap = await readClaudeQuota({ env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(snap.state).toBe('ok');
    expect(snap.state === 'ok' && snap.windows.map((w) => w.label)).toEqual(['5-hour', '7-day']);
  });
});
