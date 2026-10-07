import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { Opencode2Adapter } from './opencode2.js';
import { KARST_OPENCODE_HEADLESS_ENV } from './opencode2Bridge.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/opencode-v2/${name}`, import.meta.url)), 'utf8');

const parseNdjson = (text: string): unknown[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);

interface Receiver {
  endpointUrl: string;
  bodies: unknown[];
  close(): Promise<void>;
}

/** A real loopback HTTP receiver — the same contract the extension endpoint serves. */
function receiver(): Promise<Receiver> {
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push(body);
      }
      response.writeHead(204);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('hook receiver did not bind a TCP port'));
        return;
      }
      resolve({
        endpointUrl: `http://127.0.0.1:${address.port}/hooks`,
        bodies,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((error) => (error ? rej(error) : res()));
          }),
      });
    });
  });
}

async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error('timed out waiting for the bridge to post');
}

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc2-bridge-'));
  temporaryRoots.push(root);
  return root;
}

/**
 * Render the real generated plugin into a temp worktree, import it as the v2
 * module contract (`export default { id, setup }`), and drive `setup` with a
 * fake event stream built from the recorded live fixtures. The stream ends
 * after the supplied events, so `done` resolves once the loop drains.
 */
async function loadBridge(
  events: unknown[],
  directory: string,
  endpointUrl: string,
): Promise<{ done: Promise<void>; subscribed: () => boolean }> {
  const worktree = makeWorktree();
  const cmd = new Opencode2Adapter(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    .buildInteractiveCommand({
      cwd: worktree,
      hookChannel: { endpointUrl, configDir: join(worktree, '.karst-runtime') },
      initialPrompt: 'go',
    });
  const pluginPath = cmd.ownedPaths![0]!;
  const mod = (await import(pathToFileURL(pluginPath).href)) as {
    default: { id: string; setup(ctx: unknown): Promise<void> };
  };
  let active = false;
  const ctx = {
    location: { directory },
    event: {
      subscribe() {
        active = true;
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
  return { done: mod.default.setup(ctx), subscribed: () => active };
}

describe('generated opencode2 bridge — live event fixtures', () => {
  it('maps a text turn to busy, cumulative usage (advanced only) and idle', async () => {
    const r = await receiver();
    try {
      const { done } = await loadBridge(
        parseNdjson(fixture('live-events-baseline.ndjson')),
        '/wt',
        r.endpointUrl,
      );
      await done;
      await waitFor(() => r.bodies.length >= 4);
      const names = r.bodies.map((b) => (b as { hook_event_name: string }).hook_event_name);
      expect(names).toEqual(['session.status', 'UsageUpdate', 'UsageUpdate', 'session.idle']);

      const session = 'ses_eee50f106ffejFQFWdoMOqnYWa';
      expect(r.bodies[0]).toMatchObject({
        hook_event_name: 'session.status',
        cwd: '/wt',
        session_id: session,
        message: 'busy',
      });
      const first = (r.bodies[1] as { usage: Record<string, unknown> }).usage;
      expect(first).toMatchObject({ input: 521, output: 9, reasoning: 0, cache_read: 0, cache_write: 0 });
      expect(typeof first.event_id).toBe('string');
      const second = (r.bodies[2] as { usage: Record<string, unknown> }).usage;
      expect(second).toMatchObject({
        input: 574,
        output: 12,
        reasoning: 9,
        cache_read: 17024,
        cache_write: 0,
      });
      expect(r.bodies[3]).toMatchObject({ hook_event_name: 'session.idle', session_id: session });
    } finally {
      await r.close();
    }
  });

  it('maps permission.asked/replied for shell and external_directory', async () => {
    const r = await receiver();
    try {
      const { done } = await loadBridge(
        parseNdjson(fixture('live-permission-events.ndjson')),
        '/wt',
        r.endpointUrl,
      );
      await done;
      await waitFor(() => r.bodies.length >= 4);
      expect(r.bodies.map((b) => (b as { hook_event_name: string }).hook_event_name)).toEqual([
        'permission.asked',
        'permission.replied',
        'permission.asked',
        'permission.replied',
      ]);
      expect(r.bodies[0]).toMatchObject({
        hook_event_name: 'permission.asked',
        cwd: '/wt',
        session_id: 'ses_eee4012daffe8V2ewQf0Q3Z9zp',
      });
      expect(r.bodies[3]).toMatchObject({
        hook_event_name: 'permission.replied',
        session_id: 'ses_eee3ceab2ffeKT7ZyB3V0o1eWZ',
      });
    } finally {
      await r.close();
    }
  });

  it('captures the session id from session.created as SessionStart with the event cwd', async () => {
    const r = await receiver();
    try {
      const created = parseNdjson(fixture('plugin-events.ndjson')).filter(
        (e) => (e as { type?: string }).type === 'session.created',
      );
      const { done } = await loadBridge(created, '/wt', r.endpointUrl);
      await done;
      await waitFor(() => r.bodies.length >= 1);
      expect(r.bodies[0]).toMatchObject({
        hook_event_name: 'SessionStart',
        cwd: '<scratch>/proj2',
        session_id: 'ses_eee98a108ffePsRE0mKWV3nLUq',
      });
    } finally {
      await r.close();
    }
  });

  it('posts usage only when the cumulative tally advanced', async () => {
    const r = await receiver();
    const usageEvent = (id: string, input: number) => ({
      id,
      type: 'session.usage.updated',
      data: {
        sessionID: 'ses_u',
        tokens: { input, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    try {
      const { done } = await loadBridge(
        [usageEvent('evt-a', 10), usageEvent('evt-b', 10), usageEvent('evt-c', 25)],
        '/wt',
        r.endpointUrl,
      );
      await done;
      await waitFor(() => r.bodies.length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(r.bodies).toHaveLength(2);
      expect(
        (r.bodies as { usage: { event_id: string } }[]).map((b) => b.usage.event_id),
      ).toEqual(['evt-a', 'evt-c']);
    } finally {
      await r.close();
    }
  });

  it('posts nothing for malformed or unmapped events', async () => {
    const r = await receiver();
    try {
      const { done } = await loadBridge(
        [
          null,
          42,
          'nope',
          {},
          { type: 123 },
          { type: 'session.usage.updated', data: { sessionID: 'ses_x', tokens: 'garbage' } },
          { type: 'session.text.delta', data: { sessionID: 'ses_x', delta: 'hi' } },
          { type: 'session.created', data: {} },
          { type: 'form.created', data: { sessionID: 'ses_x' } },
        ],
        '/wt',
        r.endpointUrl,
      );
      await done;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(r.bodies).toEqual([]);
    } finally {
      await r.close();
    }
  });

  it('suppresses every post when the headless marker is set (never subscribes)', async () => {
    const r = await receiver();
    vi.stubEnv(KARST_OPENCODE_HEADLESS_ENV, '1');
    try {
      const { done, subscribed } = await loadBridge(
        parseNdjson(fixture('live-events-baseline.ndjson')),
        '/wt',
        r.endpointUrl,
      );
      await done;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(subscribed()).toBe(false);
      expect(r.bodies).toEqual([]);
    } finally {
      await r.close();
    }
  });
});
