import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGlobalFlags, runCli } from './main.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { transition } from '../workflow/machine.js';

describe('parseGlobalFlags', () => {
  it('extracts --db and --manifest, leaving the subcommand argv', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9', '--db', '/x.db', '--manifest', '/k.yml', '--md']);
    expect(g.db).toBe('/x.db');
    expect(g.manifest).toBe('/k.yml');
    expect(g.rest).toEqual(['context', 'PROJ-9', '--md']);
  });

  it('extracts --ticket for the stage marker', () => {
    const g = parseGlobalFlags(['stage', 'impl', 'pass', '--db', '/x.db', '--ticket', 'K-1']);
    expect(g.db).toBe('/x.db');
    expect(g.ticket).toBe('K-1');
    expect(g.rest).toEqual(['stage', 'impl', 'pass']);
  });

  it('leaves flags absent when not given', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9']);
    expect(g.db).toBeUndefined();
    expect(g.manifest).toBeUndefined();
    expect(g.ticket).toBeUndefined();
    expect(g.rest).toEqual(['context', 'PROJ-9']);
  });
});

describe('runCli — stage marker', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-'));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    createTicket(seed, { key: 'K-1', title: 'demo' });
    transition(seed, 1, 'scope', { kind: 'passed' }); // -> impl
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('advances impl->uat by ticket key and prints the next stage', () => {
    const out = runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1']);
    expect(out.trim()).toBe('uat');

    const check: Store = openStore(dbPath);
    const t = getTicket(check, 1);
    expect(t.stages.find((s) => s.stageKey === 'impl')?.status).toBe('passed');
    expect(t.stages.find((s) => s.stageKey === 'uat')?.status).toBe('running');
    check.close();
  });

  it('fails loudly on an unknown ticket key', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'NOPE'])).toThrow(/NOPE/);
  });

  it('requires --ticket for a stage command', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath])).toThrow(/ticket/);
  });

  it('requires --db', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--ticket', 'K-1'])).toThrow(/db/);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => runCli(['bogus', '--db', dbPath])).toThrow(/bogus|unknown/);
  });

  it('names every verb it accepts when the subcommand is unknown', () => {
    expect(() => runCli(['bogus', '--db', dbPath])).toThrow(/phase/);
  });
});
