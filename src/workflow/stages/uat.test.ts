import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { runUat, type TestRunner } from './uat.js';

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
});
