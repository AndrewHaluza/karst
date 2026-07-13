/**
 * T0.2 — Hook HTTP round-trip spike (throwaway).
 *
 * Goal: a type:"http" hook registered via --settings POSTs lifecycle events to a
 * local endpoint carrying session_id + cwd (the worktree), and never stalls the
 * agent.
 *
 * Run: npx tsx spikes/s0-hooks.ts
 *
 * Done when: logs at least SessionStart and Stop POSTs with session_id + cwd
 * present. Confirms the observability channel (§5.4).
 *
 * Findings (feed M3 / T3.4):
 *  - Per docs, HTTP hooks are inherently non-blocking: a non-2xx status or a
 *    connection failure/timeout is a non-blocking error and execution continues.
 *    So the plan's `async:true` assumption holds without an explicit flag — the
 *    endpoint returning 2xx-empty fast is enough to not stall the agent.
 *  - PermissionRequest does NOT fire under `-p`. For M3, the needs-you signal
 *    comes from Notification (idle_prompt / permission_prompt) in interactive
 *    sessions, not headless.
 *  - **SessionStart only supports type:"command" and type:"mcp_tool" hooks — NOT
 *    type:"http".** So SessionStart is bridged: a tiny `type:command` hook curls
 *    a POST to the same local endpoint. Stop (and other events) stay type:http.
 *    T3.4 (src/agent/settings.ts) generates both hook kinds against one endpoint.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUIRED_EVENTS = ['SessionStart', 'Stop'] as const;
const TIMEOUT_MS = 60_000;

interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  [k: string]: unknown;
}

interface Captured {
  event: string;
  sessionId?: string;
  cwd?: string;
}

/**
 * Build the --settings JSON.
 *
 * SessionStart can't use type:http, so it uses a type:command hook that pipes the
 * hook's stdin payload straight to our endpoint via curl. Every other event uses
 * type:http directly. Both land on the same listener.
 */
function buildSettings(url: string): string {
  const httpHook = { type: 'http', url, timeout: 10 };
  // Command hook: stdin carries the JSON payload; forward it verbatim.
  const bridgeHook = {
    type: 'command',
    command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1`,
  };
  const hooks: Record<string, unknown> = {
    SessionStart: [{ matcher: '', hooks: [bridgeHook] }],
    Stop: [{ matcher: '', hooks: [httpHook] }],
    Notification: [{ matcher: '', hooks: [httpHook] }],
  };
  return JSON.stringify({ hooks });
}

function startListener(
  onEvent: (c: Captured) => void,
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}') as HookPayload;
          const event = payload.hook_event_name ?? '(unknown)';
          onEvent({ event, sessionId: payload.session_id, cwd: payload.cwd });
        } catch {
          /* ignore malformed */
        }
        res.writeHead(200); // 2xx empty → success, don't stall the agent
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hooks`,
        close: () => server.close(),
      });
    });
  });
}

function launchClaude(settingsUrl: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'karst-hooks-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, buildSettings(settingsUrl));
  console.log(`[s0-hooks] settings: ${settingsPath}`);
  console.log(`[s0-hooks] launching: claude -p ... --settings <path> (cwd=${dir})`);

  const child = spawn(
    'claude',
    ['-p', 'Reply with exactly: pong', '--output-format', 'json', '--settings', settingsPath],
    { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.on('error', (e) => console.error(`[s0-hooks] spawn error: ${e.message}`));
  child.on('close', (code) => {
    if (code !== 0) console.error(`[s0-hooks] claude exited ${code}: ${stderr}`);
  });
}

async function main(): Promise<void> {
  const captured: Captured[] = [];
  const seen = new Set<string>();

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const listener = await startListener((c) => {
    console.log(
      `[s0-hooks] POST ${c.event}  session_id=${c.sessionId ?? '-'}  cwd=${c.cwd ?? '-'}`,
    );
    captured.push(c);
    seen.add(c.event);
    if (REQUIRED_EVENTS.every((e) => seen.has(e))) resolveDone();
  });
  console.log(`[s0-hooks] listener: ${listener.url}`);

  launchClaude(listener.url);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
  );

  try {
    await Promise.race([done, timeout]);
    console.log('\n[s0-hooks] PASS');
    for (const e of REQUIRED_EVENTS) {
      const hit = captured.find((c) => c.event === e);
      const ok = Boolean(hit && hit.sessionId && hit.cwd);
      console.log(`  ${e}: ${ok ? 'OK' : 'MISSING FIELDS'} (session_id + cwd)`);
    }
    listener.close();
    process.exit(0);
  } catch (err) {
    console.error('\n[s0-hooks] FAIL');
    console.error((err as Error).message);
    console.error(`  captured events: ${[...seen].join(', ') || '(none)'}`);
    listener.close();
    process.exit(1);
  }
}

void main();
