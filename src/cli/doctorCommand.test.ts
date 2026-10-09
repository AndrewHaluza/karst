import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { DoctorExit, parseDoctorArgs, runDoctorCommand } from './doctorCommand.js';

function seed() {
  const store = openStore(':memory:');
  store.db.prepare("INSERT INTO tickets (id, key, stage_current) VALUES (1, 'T-1', 'done')").run();
  // pid 2147483646 is not alive: a dead recorded server.
  store.db
    .prepare("INSERT INTO servers (ticket_id, repo, pid, status, kind) VALUES (1, 'r', 2147483646, 'running', 'service')")
    .run();
  return store;
}
const status = (s: ReturnType<typeof seed>): string =>
  (s.db.prepare('SELECT status FROM servers').get() as { status: string }).status;

function run(store: ReturnType<typeof seed>, rest: string[]): DoctorExit {
  try {
    runDoctorCommand(store, ':memory:', undefined, ['doctor', ...rest], {});
  } catch (e) {
    if (e instanceof DoctorExit) return e;
    throw e;
  }
  throw new Error('expected DoctorExit');
}

describe('karst doctor command', () => {
  it('parses flags and rejects junk', () => {
    expect(parseDoctorArgs(['doctor', '--fix', '--json', '--area', 'state'])).toEqual({ fix: true, json: true, areas: ['state'] });
    expect(() => parseDoctorArgs(['doctor', '--area'])).toThrow(/needs a value/);
    expect(() => parseDoctorArgs(['doctor', '--area', 'nope'])).toThrow(/--area/);
    expect(() => parseDoctorArgs(['doctor', 'x'])).toThrow(/unexpected/);
  });

  it('without --fix makes no writes', () => {
    const store = seed();
    const out = run(store, ['--json', '--area', 'state']);
    const report = JSON.parse(out.output);
    expect(report.fixRequested).toBe(false);
    expect(report.applied).toEqual([]);
    expect(report.checks.some((c: { id: string }) => c.id.startsWith('state.server-dead'))).toBe(true);
    expect(status(store)).toBe('running');
  });

  it('--fix marks the dead server stopped and logs it', () => {
    const store = seed();
    const report = JSON.parse(run(store, ['--fix', '--json', '--area', 'state']).output);
    expect(status(store)).toBe('stopped');
    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]).toMatchObject({ ok: true });
    expect(report.checks.some((c: { id: string }) => c.id.startsWith('state.server-dead'))).toBe(false);
  });

  it('exits 1 when a check fails (schema mismatch is not fixable)', () => {
    const store = seed();
    store.db.pragma('user_version = 1');
    expect(run(store, ['--area', 'state']).code).toBe(1);
  });

  it('renders text by default', () => {
    expect(run(seed(), ['--area', 'state']).output).toMatch(/ok, \d+ warn, \d+ fail/);
  });

  it('wiring: a missing KARST_CLI path fails; a real js file passes', () => {
    const wiring = (cli: string): { status: string } => {
      try {
        runDoctorCommand(seed(), ':memory:', undefined, ['doctor', '--json', '--area', 'wiring'], { KARST_CLI: cli });
      } catch (e) {
        return JSON.parse((e as DoctorExit).output).checks.find((c: { id: string }) => c.id === 'wiring.cli');
      }
      throw new Error('expected DoctorExit');
    };
    expect(wiring('/nonexistent/main.js').status).toBe('fail');
    expect(wiring(join(process.cwd(), 'vitest.config.ts')).status).toBe('fail'); // exists but not .js
    expect(wiring(join(process.cwd(), 'scripts', 'copy-assets.mjs')).status).toBe('fail'); // .mjs is not .js
    const dir = mkdtempSync(join(tmpdir(), 'doctor-cli-'));
    try {
      writeFileSync(join(dir, 'main.js'), '');
      expect(wiring(join(dir, 'main.js')).status).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manifest: reports a manifest that fails to load', () => {
    let out = '';
    try {
      runDoctorCommand(seed(), ':memory:', '/nonexistent/karst.yml', ['doctor', '--json', '--area', 'manifest'], {});
    } catch (e) {
      out = (e as DoctorExit).output;
    }
    const report = JSON.parse(out);
    expect(report.checks.find((c: { id: string }) => c.id === 'manifest.valid').status).toBe('fail');
  });

  it('stuck: an idle impl ticket with no session is reported, and never auto-fixed', () => {
    const store = seed();
    store.db.prepare("INSERT INTO tickets (id, key, stage_current, agent_state, updated_at) VALUES (2, 'T-2', 'impl', 'idle', '2020-01-01 00:00:00')").run();
    const report = JSON.parse(run(store, ['--fix', '--json', '--area', 'state']).output);
    const stuck = report.checks.find((c: { id: string }) => c.id === 'state.stuck.T-2');
    expect(stuck.fix.tier).toBe('report');
  });

  it('stuck: awaiting-merge (ship) and conflicted tickets are not flagged', () => {
    const store = seed();
    store.db.prepare("INSERT INTO tickets (id, key, stage_current, agent_state, updated_at) VALUES (3, 'T-3', 'ship', 'idle', '2020-01-01 00:00:00')").run();
    store.db.prepare("INSERT INTO tickets (id, key, stage_current, agent_state, updated_at) VALUES (4, 'T-4', 'impl', 'idle', '2020-01-01 00:00:00')").run();
    store.db.prepare("INSERT INTO merge_checks (ticket_id, repo, state, files, checked_at) VALUES (4, 'r', 'conflicted', '[]', '2020-01-01')").run();
    const ids = JSON.parse(run(store, ['--json', '--area', 'state']).output).checks.map((c: { id: string }) => c.id);
    expect(ids).not.toContain('state.stuck.T-3');
    expect(ids).not.toContain('state.stuck.T-4');
  });
});
