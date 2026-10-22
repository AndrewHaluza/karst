import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureSpec } from '../fixtures.js';
import { seedStore } from '../seed.js';
import { openStore } from '../../store/db.js';
import { ProbeRecorder } from './recorder.js';
import { runProbeScript } from './session.js';
import { readTickets } from './storeEvidence.js';
import type { ProbeHost } from './runner.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function hostFor(fixture: (typeof FIXTURE_NAMES)[number], rec: ProbeRecorder): ProbeHost {
  const store = openStore(':memory:');
  seedStore(store, fixtureSpec(fixture));
  return {
    execute: async (c) => { rec.logLine(`ran ${c}`); },
    restart: async () => undefined,
    snapshot: () => ({ tickets: readTickets(store), sidebar: { lastMessage: null }, launches: [], ...rec.view() }),
  };
}

describe('runProbeScript', () => {
  const script = [
    { type: 'command', command: 'karst.noop' },
    { type: 'wait', for: { log: 'ran karst.noop' } },
    { type: 'snapshot', label: 'end' },
  ];

  it.each(FIXTURE_NAMES)('yields byte-stable evidence against fixture %s', async (fixture) => {
    dir = mkdtempSync(join(tmpdir(), 'probe-'));
    const scriptPath = join(dir, 's.json');
    writeFileSync(scriptPath, JSON.stringify(script));
    const read = async (out: string) => {
      const results = await runProbeScript({ scriptPath, outDir: join(dir, out) }, hostFor(fixture, new ProbeRecorder()));
      expect(results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass']);
      return readdirSync(join(dir, out)).sort().map((f) => readFileSync(join(dir, out, f), 'utf8'));
    };
    const a = await read('a');
    expect(a).toHaveLength(4);
    expect(await read('b')).toEqual(a);
    const last = JSON.parse(a[2]!) as { snapshot: { tickets: unknown[] } };
    expect(last.snapshot.tickets).toHaveLength(fixtureSpec(fixture).tickets.length);
  });

  it('summarises a timed-out step with its index', async () => {
    dir = mkdtempSync(join(tmpdir(), 'probe-'));
    const scriptPath = join(dir, 's.json');
    writeFileSync(scriptPath, JSON.stringify([{ type: 'snapshot' }, { type: 'wait', for: { log: 'never' }, timeoutMs: 20 }, { type: 'snapshot' }]));
    await runProbeScript({ scriptPath, outDir: dir }, hostFor('empty', new ProbeRecorder()));
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { total: number; ran: number; results: Array<{ index: number; status: string }> };
    expect(summary).toMatchObject({ total: 3, ran: 2 });
    expect(summary.results[1]).toMatchObject({ index: 1, status: 'timeout' });
  });
});

describe('readTickets', () => {
  it('reports the blocked fixture block kind', () => {
    const store = openStore(':memory:');
    seedStore(store, fixtureSpec('blocked'));
    const [t] = readTickets(store);
    expect(t).toMatchObject({ key: 'FIX-BLOCKED', title: 'Fixture: blocked ticket', stage: 'uat' });
    expect(t?.stages.find((x) => x.stage === 'uat')).toEqual({ stage: 'uat', status: 'running', blockedKind: 'boot-failed' });
    expect(t?.stages.filter((x) => x.blockedKind)).toHaveLength(1);
  });
});
