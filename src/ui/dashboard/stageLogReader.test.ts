import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../store/db.js';
import { setStage } from '../../store/stages.js';
import { createTicket } from '../../store/tickets.js';
import { readStageLog, STAGE_LOG_READ_CAP_BYTES } from './stageLogReader.js';

const read = (p: string): string => readFileSync(p, 'utf8');

describe('readStageLog', () => {
  it('returns the artifact file content for a gate stage that has one', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { artifactPath: '/tmp/karst-uat.log' });
    const dir = mkdtempSync(join(tmpdir(), 'karst-log-'));
    const path = join(dir, 'uat.log');
    writeFileSync(path, '# gate (exit 0)\n\x1b[32mpass\x1b[0m\n');
    setStage(store, ticketId, 'uat', { artifactPath: path });

    const result = readStageLog(store, ticketId, 'uat', read);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.content).toContain('\x1b[32mpass\x1b[0m');
      expect(result.truncated).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a stage with no recorded artifact (error, never invented content)', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-2', title: 't' }).id;
    const result = readStageLog(store, ticketId, 'review', read);
    expect(result).toEqual({ kind: 'error', message: 'This stage has no recorded console log.' });
  });

  it('reports a missing file as error, never a throw', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-3', title: 't' }).id;
    setStage(store, ticketId, 'uat', { artifactPath: '/tmp/does-not-exist-869e7n906.log' });
    const result = readStageLog(store, ticketId, 'uat', read);
    expect(result.kind).toBe('error');
  });

  it('caps oversized files and marks them truncated', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-4', title: 't' }).id;
    const dir = mkdtempSync(join(tmpdir(), 'karst-log-'));
    const path = join(dir, 'big.log');
    writeFileSync(path, 'x'.repeat(STAGE_LOG_READ_CAP_BYTES + 100));
    setStage(store, ticketId, 'uat', { artifactPath: path });

    const result = readStageLog(store, ticketId, 'uat', read);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThan(STAGE_LOG_READ_CAP_BYTES + 200);
      expect(result.content).toContain('[console output truncated]');
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
