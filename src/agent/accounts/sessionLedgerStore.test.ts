import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SESSION_LEDGER_MAX } from './registry.js';
import { appendSessionLedger, loadSessionLedger, SESSION_LEDGER_FILE } from './sessionLedgerStore.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ledger-store-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('keeps the entries of another window when this window appends', async () => {
  await writeFile(join(root, SESSION_LEDGER_FILE), JSON.stringify({ 'claude:other': 'w2' }));
  await appendSessionLedger(root, 'claude:mine', 'w1');
  expect(await loadSessionLedger(root)).toEqual({ 'claude:other': 'w2', 'claude:mine': 'w1' });
});

it('runs parallel appends one after the other and loses none', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendSessionLedger(root, `claude:s${i}`, 'a')));
  expect(Object.keys(await loadSessionLedger(root))).toHaveLength(20);
});

it('moves a repeated key to the newest place and drops the oldest over the bound', async () => {
  const full = Object.fromEntries(Array.from({ length: SESSION_LEDGER_MAX }, (_, i) => [`claude:s${i}`, 'a']));
  await writeFile(join(root, SESSION_LEDGER_FILE), JSON.stringify(full));
  await appendSessionLedger(root, 'claude:s1', 'b');
  let got = await loadSessionLedger(root);
  expect(Object.keys(got)).toHaveLength(SESSION_LEDGER_MAX);
  expect(Object.keys(got).at(-1)).toBe('claude:s1');
  expect(got['claude:s1']).toBe('b');
  await appendSessionLedger(root, 'claude:new', 'c');
  got = await loadSessionLedger(root);
  expect(got['claude:s0']).toBeUndefined();
  expect(Object.keys(got)).toHaveLength(SESSION_LEDGER_MAX);
});

it('replaces an unreadable file and keeps writing after a failed write', async () => {
  await writeFile(join(root, SESSION_LEDGER_FILE), '{bad');
  await appendSessionLedger(root, 'claude:a', 'x');
  expect(JSON.parse(await readFile(join(root, SESSION_LEDGER_FILE), 'utf8'))).toEqual({ 'claude:a': 'x' });
  const blocker = join(root, 'blocker');
  await writeFile(blocker, 'x');
  await expect(appendSessionLedger(blocker, 'claude:b', 'y')).rejects.toThrow();
  await expect(appendSessionLedger(blocker, 'claude:b', 'y')).rejects.toThrow();
});
