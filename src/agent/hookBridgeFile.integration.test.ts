import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACK_EMIT, HOOK_BRIDGE, MARKER_EMIT } from './hookBridge.js';
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
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveNodeExecutable(), [script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], ...(opts.cwd ? { cwd: opts.cwd } : {}), env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

function ticketDir(name: string): string {
  const dir = join(mkdtempSync(join(root, 'case-')), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bridge.cjs'), HOOK_BRIDGE);
  writeFileSync(join(dir, 'emit-marker.cjs'), MARKER_EMIT);
  writeFileSync(join(dir, 'emit-ack.cjs'), ACK_EMIT);
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
    expect(res).toMatchObject({ code: 0, stdout: '' });
    expect(Date.now() - started).toBeLessThan(1400);
    const got = lines(events) as Array<{ payload: { hook_event_name: string } }>;
    expect(got.map((l) => l.payload.hook_event_name)).toEqual(['Stop', 'UsageUpdate']);
  });
});

describe('MARKER_EMIT', () => {
  const FAST = { KARST_MARKER_WAIT_MS: '400' };
  /** A clean scratch git repo: the dirty-tree pre-check passes there. */
  const scratch = (): string => {
    const repo = mkdtempSync(join(root, 'cwd-'));
    spawnSync('git', ['init', '-q'], { cwd: repo });
    return repo;
  };
  const replyFile = (events: string, seq: string): string => join(events, '..', 'results', `${seq}.json`);
  const reply = (events: string, body: object): void => {
    // Answer as the host would: watch the events file, write results/<seq>.json.
    const timer = setInterval(() => {
      if (!existsSync(events)) return;
      const seq = (lines(events).at(-1) as { seq?: string } | undefined)?.seq;
      if (!seq) return;
      mkdirSync(join(events, '..', 'results'), { recursive: true });
      writeFileSync(replyFile(events, seq), JSON.stringify(body));
      clearInterval(timer);
    }, 20);
  };

  it('appends a marker line with a seq and rejects an unknown stage', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    reply(events, { v: 1, stage: 'impl', ok: true, retrying: false, reason: '' });
    const ok = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '', { cwd: scratch(), env: FAST });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('accepted');
    const [line] = lines(events) as Array<{ seq: string }>;
    expect(line).toMatchObject({ v: 1, kind: 'marker', ticket: 7, stage: 'impl' });
    expect(line!.seq).toMatch(/^[0-9a-f]{16}$/);
    const bad = await runNode(join(dir, 'emit-marker.cjs'), [events, 'ship'], '', { cwd: scratch() });
    expect(bad.code).toBe(1);
    expect(lines(events)).toHaveLength(1);
  });
  it('a refusal reply exits 1 with the host reason', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    reply(events, { v: 1, stage: 'impl', ok: false, retrying: false, reason: 'karst: cannot mark this stage done: no repository has changes' });
    const out = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '', { cwd: scratch(), env: FAST });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('no repository has changes');
  });
  it('a retrying reply exits 3: queued, the host retries', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    reply(events, { v: 1, stage: 'impl', ok: false, retrying: true, reason: 'sync failed' });
    const out = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '', { cwd: scratch(), env: FAST });
    expect(out.code).toBe(3);
    expect(out.stdout).toContain('queued');
  });
  it('no reply within the wait: says queued and exits 3', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    const out = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '', { cwd: scratch(), env: { KARST_MARKER_WAIT_MS: '300' } });
    expect(out.code).toBe(3);
    expect(out.stdout).toContain('queued');
    expect(lines(events)).toHaveLength(1);
  });
  it('an uncommitted change refuses locally and writes no line', async () => {
    const repo = scratch();
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
    git('init', '-q');
    writeFileSync(join(repo, 'f.txt'), 'x');
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    const out = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '', { cwd: repo, env: FAST });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('Commit your changes first');
    expect(out.stderr).toContain('f.txt');
    expect(existsSync(events)).toBe(false);
  });
  it('a failing `git status` refuses (exit 1) and writes no line: an unknown tree is never a done marker', async () => {
    const notARepo = mkdtempSync(join(root, 'plain-'));
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    const out = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '', { cwd: notARepo, env: { ...FAST, GIT_CEILING_DIRECTORIES: root } });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('git status failed');
    expect(existsSync(events)).toBe(false);
  });
  it('a clean tree with zero commits is not refused', async () => {
    const repo = scratch();
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    const out = await runNode(join(dir, 'emit-marker.cjs'), [events, 'impl'], '', { cwd: repo, env: { KARST_MARKER_WAIT_MS: '200' } });
    expect(out.code).toBe(3);
    expect(lines(events)).toHaveLength(1);
  });
});

describe('ACK_EMIT (F10)', () => {
  it('appends an ack line for the ticket named by the events dir', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    const out = await runNode(join(dir, 'emit-ack.cjs'), [events, 'fix-12'], '');
    expect(out.code).toBe(0);
    expect(lines(events)).toEqual([{ v: 1, kind: 'ack', ticket: 7, ref: 'fix-12' }]);
  });
  it('rejects a ref that is not a token and a dir that is not a ticket id', async () => {
    const dir = ticketDir('7');
    const events = join(dir, 'events.ndjson');
    expect((await runNode(join(dir, 'emit-ack.cjs'), [events, '../x'], '')).code).toBe(1);
    const odd = mkdtempSync(join(root, 'odd-'));
    expect((await runNode(join(dir, 'emit-ack.cjs'), [join(odd, 'events.ndjson'), 'fix-1'], '')).code).toBe(1);
    expect(existsSync(events)).toBe(false);
  });
});
