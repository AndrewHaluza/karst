import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store/db.js';
import { openReadonlyStore } from './readonlyStore.js';
import { openWritableStore } from './writableStore.js';
import { SCHEMA_VERSION } from '../store/migrations.js';

/**
 * Neither CLI store migrates — only the extension does. A stale registry must
 * therefore fail with an actionable message, not with whatever raw SQL error
 * the first query happens to produce (`no such column: repo`, since v10 renamed
 * `service` on three tables).
 */
describe('CLI schema guard', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function dbAt(version: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'karst-cli-guard-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY)');
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    return path;
  }

  it('refuses a pre-v10 registry with a message naming the versions and the fix', () => {
    const path = dbAt(9);
    expect(() => openReadonlyStore(path)).toThrow(/schema v9/);
    expect(() => openReadonlyStore(path)).toThrow(new RegExp(`v${SCHEMA_VERSION}`));
    expect(() => openReadonlyStore(path)).toThrow(/Open the Karst extension once to migrate/);
  });

  it('names the offending file', () => {
    const path = dbAt(9);
    expect(() => openReadonlyStore(path)).toThrow(path);
  });

  it('refuses on the writable path too, before any stage marker is written', () => {
    const path = dbAt(9);
    expect(() => openWritableStore(path)).toThrow(/schema v9/);
  });

  it('opens a migrated registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-cli-ok-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    openStore(path).close(); // extension-side migration brings it to SCHEMA_VERSION

    const ro = openReadonlyStore(path);
    cleanups.push(() => ro.close());
    expect(ro.db).toBeDefined();

    const rw = openWritableStore(path);
    cleanups.push(() => rw.close());
    expect(rw.db).toBeDefined();
  });
});
