import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_BRIDGE, MARKER_EMIT } from './hookBridge.js';
import { resolveNodeExecutable } from './nodeExecutable.js';

/**
 * The FILE transport of the shared hook script (sandbox evidence bridge): the
 * script appends one NDJSON line per post to `file://<dir>/<ticket>/events.ndjson`
 * and never touches the network. Spawns real node processes → integration.
 */

const root = mkdtempSync(join(tmpdir(), 'karst-hbfile-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runNode(
  script: string,
  args: string[],
  input: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveNodeExecutable(), [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(input);
  });
}

function ticketDir(name: string): string {
  const dir = join(mkdtempSync(join(root, 'case-')), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bridge.cjs'), HOOK_BRIDGE);
  writeFileSync(join(dir, 'emit-marker.cjs'), MARKER_EMIT);
  return dir;
}

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
}

describe('HOOK_BRIDGE file transport', () => {
  it('appends one verified-shape line and exits 0 without any network', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    const input = JSON.stringify({ hook_event_name: 'PermissionRequest', cwd: '/sandbox/repo', session_id: 's1' });
    const res = await runNode(join(dir, 'bridge.cjs'), [`file://${events}`, join(dir, 'diag.jsonl'), 'claude'], input);
    expect(res.code).toBe(0);
    expect(lines(events)).toEqual([{
      v: 1, kind: 'hook', ticket: 7,
      payload: { hook_event_name: 'Notification', message: 'permission_prompt', cwd: '/sandbox/repo', session_id: 's1' },
    }]);
  });

  it('ignores an http current-endpoint fallback in file mode', async () => {
    const dir = ticketDir('8');
    mkdirSync(join(dir, 'claude'));
    writeFileSync(join(dir, 'claude', 'current-endpoint'), 'http://127.0.0.1:1/hooks');
    const events = join(dir, 'events.ndjson');
    const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/r', session_id: 's1' });
    const res = await runNode(join(dir, 'bridge.cjs'), [`file://${events}`, join(dir, 'claude', 'hook-failures.jsonl'), 'claude'], input);
    expect(res.code).toBe(0);
    expect(lines(events)).toHaveLength(1);
  });

  it('fails open: an unwritable events path exits 0 and logs', async () => {
    const dir = ticketDir('9');
    const diag = join(dir, 'diag.jsonl');
    const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/r', session_id: 's1' });
    const res = await runNode(join(dir, 'bridge.cjs'), [`file://${join(dir, 'missing', '9', 'events.ndjson')}`, diag, 'claude'], input);
    expect(res.code).toBe(0);
    expect(readFileSync(diag, 'utf8')).toContain('request-error:ENOENT');
  });

  it('a non-numeric ticket dir exits 0 silently and logs invalid-endpoint', async () => {
    const dir = ticketDir('abc');
    const diag = join(dir, 'diag.jsonl');
    const events = join(dir, 'events.ndjson');
    const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/r', session_id: 's1' });
    const res = await runNode(join(dir, 'bridge.cjs'), [`file://${events}`, diag, 'claude'], input);
    expect(res.code).toBe(0);
    expect(existsSync(events)).toBe(false);
    expect(readFileSync(diag, 'utf8')).toContain('invalid-endpoint');
  });

  it('writes a UsageUpdate line when usage is present, and a Stop never waits', async () => {
    const dir = ticketDir('10');
    const events = join(dir, 'events.ndjson');
    const input = JSON.stringify({ hook_event_name: 'Stop', cwd: '/r', session_id: 's1', usage: { event_id: 'e1', input: 1, output: 2 } });
    const started = Date.now();
    const res = await runNode(join(dir, 'bridge.cjs'), [`file://${events}`, join(dir, 'diag.jsonl'), 'codex'], input);
    expect(res).toEqual({ code: 0, stdout: '' });
    expect(Date.now() - started).toBeLessThan(1400);
    const got = lines(events) as Array<{ payload: { hook_event_name: string } }>;
    expect(got.map((l) => l.payload.hook_event_name)).toEqual(['Stop', 'UsageUpdate']);
  });
});

describe('MARKER_EMIT', () => {
  it('appends a marker line and rejects an unknown stage', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    const ok = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '');
    expect(ok.code).toBe(0);
    expect(lines(events)).toEqual([{ v: 1, kind: 'marker', ticket: 7, stage: 'impl' }]);
    const bad = await runNode(join(dir, 'emit-marker.cjs'), [events, 'ship'], '');
    expect(bad.code).toBe(1);
    expect(lines(events)).toHaveLength(1);
  });
});
