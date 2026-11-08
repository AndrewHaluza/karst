import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSteps, type ProbeHost } from './runner.js';
import { parseSteps } from './steps.js';
import { createUiClient, type UiDriver } from './uiClient.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sockPath = () => { const d = mkdtempSync(join(tmpdir(), 'uiclient-')); dirs.push(d); return join(d, 'ui.sock'); };
const listen = (path: string, reply: (line: string) => string) => new Promise<void>((resolve) => {
  const server = createServer((c) => { c.setEncoding('utf8'); c.on('data', (d: string) => c.end(`${reply(d)}\n`)); });
  servers.push(server);
  server.listen(path, resolve);
});
const click = parseSteps([{ type: 'click', target: { act: 'a' } }])[0]!;
const uiStep = (click.type === 'click' ? click : undefined)!;

describe('createUiClient', () => {
  it('sends the step as one JSON line and returns the outcome', async () => {
    const path = sockPath();
    let got = '';
    await listen(path, (d) => { got = d; return JSON.stringify({ status: 'pass', ui: { screenshot: 's.png', visibleActs: [], textAdded: [], textRemoved: [] } }); });
    const r = await createUiClient(path).run(3, uiStep, 1000);
    expect(r.status).toBe('pass');
    expect(JSON.parse(got)).toEqual({ index: 3, step: uiStep, timeoutMs: 1000 });
  });
  it('waits for a driver that is still starting', async () => {
    const path = sockPath();
    const pending = createUiClient(path).run(0, uiStep, 3000);
    await new Promise((r) => setTimeout(r, 250));
    await listen(path, () => JSON.stringify({ status: 'fail', detail: 'x' }));
    expect((await pending).detail).toBe('x');
  });
  it('rejects when the driver never appears', async () => {
    await expect(createUiClient(sockPath()).run(0, uiStep, 200)).rejects.toThrow('unreachable');
  });
  it('rejects an unreadable reply', async () => {
    const path = sockPath();
    await listen(path, () => '{"nope":1}');
    await expect(createUiClient(path).run(0, uiStep, 1000)).rejects.toThrow('unreadable');
  });
});

describe('runSteps with UI steps', () => {
  const snap = () => ({ tickets: [], sidebar: { lastMessage: null }, webviews: [], notifications: [], logTail: [], launches: [] });
  const run = (host: Partial<ProbeHost>) => {
    const ev: unknown[] = [];
    return runSteps(parseSteps([{ type: 'read' }]), { host: { execute: async () => undefined, restart: async () => undefined, snapshot: snap, ...host }, writeEvidence: (_i, e) => { ev.push(e); } })
      .then((results) => ({ results, ev }));
  };
  it('puts the driver evidence under `ui` next to the snapshot', async () => {
    const ui: UiDriver = { run: async () => ({ status: 'pass', ui: { screenshot: 'step-000.png', visibleActs: ['a'], textAdded: ['t'], textRemoved: [] } }) };
    const { results, ev } = await run({ ui });
    expect(results[0]?.status).toBe('pass');
    expect(ev[0]).toMatchObject({ snapshot: expect.any(Object), ui: { screenshot: 'step-000.png', visibleActs: ['a'], textAdded: ['t'], textRemoved: [] } });
  });
  it('keeps the driver reason of a failed step in result.detail', async () => {
    const { results } = await run({ ui: { run: async () => ({ status: 'fail', detail: 'not visible' }) } });
    expect(results[0]).toMatchObject({ status: 'fail', detail: 'not visible' });
  });
  it('fails a UI step when the harness started no driver', async () => {
    const { results } = await run({});
    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.detail).toContain('no UI driver');
  });
  it('reports a driver channel error as a failed step', async () => {
    const { results } = await run({ ui: { run: async () => { throw new Error('unreachable'); } } });
    expect(results[0]).toMatchObject({ status: 'fail', detail: 'unreachable' });
  });
  it('gives the driver the step timeout less the reply grace when the script budget is tight', async () => {
    const seen: number[] = [];
    const ev: unknown[] = [];
    await runSteps(parseSteps([{ type: 'read', timeoutMs: 30_000 }]), {
      host: {
        execute: async () => undefined, restart: async () => undefined, snapshot: () => ({}) as never,
        ui: { run: async (_i, _s, ms) => { seen.push(ms); return { status: 'pass' as const }; } },
      },
      totalTimeoutMs: 20_000,
      writeEvidence: (_i, e) => { ev.push(e); },
    });
    expect(seen).toEqual([5000]);
  });
});
