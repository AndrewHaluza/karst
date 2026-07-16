import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { runUat, makeNpmTestRunner, type TestRunner } from './uat.js';

function walkToUat(store: Store, id: number): void {
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
}

describe('runUat', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    walkToUat(store, id);
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-uat-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('a passing suite (exit 0) -> passed verdict and advances to review', async () => {
    const runner: TestRunner = async () => ({ exitCode: 0, output: 'all green\n' });
    const res = await runUat(store, { ticketId: id, cwd: '/wt', artifactDir }, runner);
    expect(res.verdict).toEqual({ kind: 'passed' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  it('a failing suite (nonzero exit) -> failed verdict and routes to fix', async () => {
    const runner: TestRunner = async () => ({ exitCode: 1, output: '1 failing\n' });
    const res = await runUat(store, { ticketId: id, cwd: '/wt', artifactDir }, runner);
    expect(res.verdict.kind).toBe('failed');
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });

  it('writes the suite output to an artifact file and records its path', async () => {
    const runner: TestRunner = async () => ({ exitCode: 0, output: 'captured output\n' });
    const res = await runUat(store, { ticketId: id, cwd: '/wt', artifactDir }, runner);
    expect(readFileSync(res.artifactPath, 'utf8')).toContain('captured output');
    const uat = getTicket(store, id).stages.find((s) => s.stageKey === 'uat');
    expect(uat?.artifactPath).toBe(res.artifactPath);
  });

  it('the verdict comes from the exit code, not the output text', async () => {
    // Output literally says "passed" but exit code is nonzero -> still failed.
    const runner: TestRunner = async () => ({ exitCode: 2, output: 'tests passed!\n' });
    const res = await runUat(store, { ticketId: id, cwd: '/wt', artifactDir }, runner);
    expect(res.verdict.kind).toBe('failed');
  });

  // A suite that never ran is not a suite that failed. `npm test` in a repo with
  // no test script exits 1 with "Missing script", which said nothing about the
  // ticket's code and parked it at fix forever — the agent cannot fix code that
  // is not broken. Same bug the review gates had (e962485).
  it('a suite that did not run (null) -> passed, and never routes to fix', async () => {
    const runner: TestRunner = async () => ({ exitCode: null, output: 'no test script\n' });
    const res = await runUat(store, { ticketId: id, cwd: '/wt', artifactDir }, runner);
    expect(res.verdict).toEqual({ kind: 'passed' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  it('records that the suite did not run, so the pass is not mistaken for a green suite', async () => {
    const runner: TestRunner = async () => ({ exitCode: null, output: 'no test script\n' });
    const res = await runUat(store, { ticketId: id, cwd: '/wt', artifactDir }, runner);
    expect(readFileSync(res.artifactPath, 'utf8')).toContain('did not run');
  });
});

describe('makeNpmTestRunner', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'karst-uat-repo-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('reports null — did not run — when the repo defines no test script', async () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const r = await makeNpmTestRunner()(cwd);
    expect(r.exitCode).toBeNull();
    expect(r.output).toContain('no "test" script');
  });

  it('reports null when there is no package.json at all', async () => {
    expect((await makeNpmTestRunner()(cwd)).exitCode).toBeNull();
  });

  it('runs the suite when the repo defines one', async () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'exit 3' } }));
    expect((await makeNpmTestRunner()(cwd)).exitCode).toBe(3);
  });
});
