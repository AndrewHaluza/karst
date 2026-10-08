import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_BRIDGE } from './hookBridge.js';
import { resolveNodeExecutable } from './nodeExecutable.js';

/**
 * The mail reply channel's bridge half: a Stop whose endpoint answers with a
 * block body must print that JSON to stdout and exit 0; every other event,
 * guard, failure or timeout must exit 0 with NO stdout (fail-open).
 *
 * Spawns real node processes → integration suite (AGENTS.md naming rule).
 */

const dir = mkdtempSync(join(tmpdir(), 'karst-hookbridge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BRIDGE = join(dir, 'bridge.cjs');
writeFileSync(BRIDGE, HOOK_BRIDGE);
const DIAGNOSTICS = join(dir, 'codex', 'hook-failures.jsonl');

function runBridge(
  endpointUrl: string,
  input: unknown,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveNodeExecutable(), [BRIDGE, endpointUrl, DIAGNOSTICS, 'codex'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

interface Receiver {
  url: string;
  close(): Promise<void>;
}

/** A receiver that answers every POST with the given status + body. */
function receiver(status: number, body: string): Promise<Receiver> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hooks`,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

/** A receiver that accepts the request but never answers (timeout path). */
function blackHole(): Promise<Receiver> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, _res) => {
      // Never respond.
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hooks`,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

/** A receiver whose answer sees the posted body (so it can branch per event). */
function receiverOn(
  answer: (body: Record<string, unknown>, res: import('node:http').ServerResponse) => void,
): Promise<Receiver> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {}
        answer(parsed, res);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hooks`,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

const STOP = { hook_event_name: 'Stop', cwd: dir, session_id: 'sess-1' };
const USAGE = { event_id: 'e1', input: 1, output: 2 };
const BLOCK = JSON.stringify({ decision: 'block', reason: 'karst: 2 new message(s) - run inbox' });

describe('HOOK_BRIDGE mail reply', () => {
  it('prints the block JSON and exits 0 for an eligible Stop', async () => {
    const r = await receiver(200, BLOCK);
    try {
      const { exitCode, stdout } = await runBridge(r.url, STOP);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        decision: 'block',
        reason: 'karst: 2 new message(s) - run inbox',
      });
    } finally {
      await r.close();
    }
  });

  it('posts a delivery ACK after printing the block', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const r = await receiverOn((body, res) => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body.hook_event_name === 'Stop' ? BLOCK : '');
    });
    try {
      const { exitCode, stdout } = await runBridge(r.url, STOP);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).decision).toBe('block');
      expect(bodies.map((b) => b.hook_event_name)).toContain('MailReplyAck');
    } finally {
      await r.close();
    }
  });

  it('does not post an ACK when no block was captured', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const r = await receiverOn((body, res) => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(''); // 2xx with no block
    });
    try {
      const { exitCode, stdout } = await runBridge(r.url, STOP);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
      expect(bodies.map((b) => b.hook_event_name)).not.toContain('MailReplyAck');
    } finally {
      await r.close();
    }
  });

  it('does not block when stop_hook_active is true', async () => {
    const r = await receiver(200, BLOCK);
    try {
      const { exitCode, stdout } = await runBridge(r.url, { ...STOP, stop_hook_active: true });
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      await r.close();
    }
  });

  it('does not block a question turn (Stop remapped to Notification idle_prompt)', async () => {
    const r = await receiver(200, BLOCK);
    try {
      const { exitCode, stdout } = await runBridge(r.url, {
        ...STOP,
        last_assistant_message: 'Should I continue?',
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      await r.close();
    }
  });

  it('ignores a block body on a non-Stop event', async () => {
    const r = await receiver(200, BLOCK);
    try {
      const { exitCode, stdout } = await runBridge(r.url, {
        hook_event_name: 'SessionStart',
        cwd: dir,
        session_id: 'sess-1',
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      await r.close();
    }
  });

  it('ignores a body that is not a block decision', async () => {
    const r = await receiver(200, JSON.stringify({ ok: true }));
    try {
      const { exitCode, stdout } = await runBridge(r.url, STOP);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      await r.close();
    }
  });

  it('fails open on a malformed reply body', async () => {
    const r = await receiver(200, 'not json');
    try {
      const { exitCode, stdout } = await runBridge(r.url, STOP);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      await r.close();
    }
  });

  it('fails open (exit 0, no output) on a non-2xx reply answer', async () => {
    const r = await receiver(500, 'boom');
    try {
      const { exitCode, stdout } = await runBridge(r.url, STOP);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      await r.close();
    }
  });

  it('fails open (exit 0, no output) when the endpoint is dead', async () => {
    const { exitCode, stdout } = await runBridge('http://127.0.0.1:1/hooks', STOP);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('bounds the WHOLE Stop hook when a usage sibling hangs (block still flushed)', async () => {
    // The Stop reply lands at 1.4 s; the sibling UsageUpdate post then hangs.
    // A per-request timeout would let the total reach ~3.4 s and exceed codex's
    // 3 s Stop hook, so the invocation itself must be bounded at 1.5 s.
    const r = await receiverOn((body, res) => {
      if (body.hook_event_name === 'Stop') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(BLOCK);
        }, 800);
      }
      // UsageUpdate / ACK: never answer.
    });
    try {
      const started = Date.now();
      const { exitCode, stdout } = await runBridge(r.url, { ...STOP, usage: USAGE });
      const elapsed = Date.now() - started;
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        decision: 'block',
        reason: 'karst: 2 new message(s) - run inbox',
      });
      expect(elapsed).toBeLessThan(2900);
    } finally {
      await r.close();
    }
  });

  it('keeps exit 0 when a usage sibling post fails after a block was captured', async () => {
    const r = await receiverOn((body, res) => {
      if (body.hook_event_name === 'Stop') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(BLOCK);
      } else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('boom');
      }
    });
    try {
      const { exitCode, stdout } = await runBridge(r.url, { ...STOP, usage: USAGE });
      // The block is the deliverable: a failed sibling must not turn it into an
      // exit-1 the agent would ignore.
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        decision: 'block',
        reason: 'karst: 2 new message(s) - run inbox',
      });
    } finally {
      await r.close();
    }
  });

  it('forwards stop_hook_active so the host can decline without spending the block', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const r = await receiverOn((body, res) => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(BLOCK);
    });
    try {
      const { exitCode, stdout } = await runBridge(r.url, { ...STOP, stop_hook_active: true });
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ hook_event_name: 'Stop', stop_hook_active: true });
    } finally {
      await r.close();
    }
  });

  it('fails open on a timeout below the Stop hook timeout', async () => {
    const r = await blackHole();
    try {
      const started = Date.now();
      const { exitCode, stdout } = await runBridge(r.url, STOP);
      const elapsed = Date.now() - started;
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
      // The reply request's 1.5 s ceiling must fire; the whole run stays well
      // under the 3 s codex / 5 s claude Stop hook timeout.
      expect(elapsed).toBeLessThan(2900);
    } finally {
      await r.close();
    }
  });
});
