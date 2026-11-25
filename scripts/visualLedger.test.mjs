import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEDGER_REL,
  judgeLedger,
  ledgerGrowth,
  ledgerKey,
  parseLedger,
  pruneLedger,
  readLedger,
  serializeLedger,
} from './visualLedger.mjs';

const A = 'dark|pages.visual.ts::a';
const B = 'dark|pages.visual.ts::b';
const C = 'light|pages.visual.ts::a';

describe('ledgerKey', () => {
  it('joins project, file and title as the sweep gate names a screenshot', () => {
    expect(ledgerKey({ project: 'dark', file: 'pages.visual.ts', title: 'a' })).toBe(A);
  });

  it('keeps an empty project and file instead of "undefined"', () => {
    expect(ledgerKey({ title: 't' })).toBe('|::t');
  });
});

describe('parseLedger', () => {
  it('accepts an array of strings', () => {
    expect(parseLedger(JSON.stringify([B, A]), 'x')).toEqual([B, A]);
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', '{"a":1}'],
    ['a non-string entry', '["a", 1]'],
    ['an empty entry', '[""]'],
    ['a duplicate entry', JSON.stringify([A, A])],
  ])('throws on %s, naming the source', (_label, text) => {
    expect(() => parseLedger(text, 'the-ledger.json')).toThrow(/the-ledger\.json/);
  });
});

describe('readLedger', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads the committed ledger file', () => {
    dir = mkdtempSync(join(tmpdir(), 'visual-ledger-'));
    const path = join(dir, 'ledger.json');
    writeFileSync(path, JSON.stringify([A]));
    expect(readLedger(path)).toEqual([A]);
  });

  it('throws when the file is missing, never an empty ledger', () => {
    dir = mkdtempSync(join(tmpdir(), 'visual-ledger-'));
    expect(() => readLedger(join(dir, 'absent.json'))).toThrow(/cannot read the visual ledger/);
  });

  it('points at the committed path next to the layout ledger', () => {
    expect(LEDGER_REL).toBe('tests/visual/visual-known-failures.json');
  });
});

describe('serializeLedger', () => {
  it('sorts, dedupes and ends with a newline', () => {
    expect(serializeLedger([B, A, B])).toBe(`${JSON.stringify([A, B], null, 2)}\n`);
  });

  it('writes an empty ledger as []', () => {
    expect(serializeLedger([])).toBe('[]\n');
  });
});

describe('judgeLedger', () => {
  const statuses = (entries) => new Map(entries);

  it('a failure the ledger does not list is unexpected; a listed one is known', () => {
    const r = judgeLedger({ statuses: statuses([[A, 'unexpected'], [B, 'unexpected']]), ledger: [A], fullRun: true });
    expect(r.unexpected).toEqual([B]);
    expect(r.known).toEqual([A]);
  });

  it('the same id in another project is not covered', () => {
    const r = judgeLedger({ statuses: statuses([[C, 'unexpected']]), ledger: [A], fullRun: false });
    expect(r.unexpected).toEqual([C]);
  });

  it('a flaky screenshot blocks nothing and keeps its entry', () => {
    const r = judgeLedger({ statuses: statuses([[A, 'flaky'], [B, 'flaky']]), ledger: [A], fullRun: true });
    expect(r).toEqual({ unexpected: [], known: [], stale: [], flaky: [B] });
  });

  it('on a full run, an entry whose test passed or no longer exists is stale', () => {
    const r = judgeLedger({ statuses: statuses([[A, 'expected']]), ledger: [A, B], fullRun: true });
    expect(r.stale).toEqual([A, B]);
  });

  it('on a scoped run, no entry is stale', () => {
    const r = judgeLedger({ statuses: statuses([[A, 'expected']]), ledger: [A, B], fullRun: false });
    expect(r.stale).toEqual([]);
  });

  it('an entry whose test was skipped with a result is not stale', () => {
    const r = judgeLedger({ statuses: statuses([[A, 'skipped']]), ledger: [A], fullRun: true });
    expect(r.stale).toEqual([]);
  });
});

describe('pruneLedger', () => {
  const guard = { authoritative: true, fullRun: true };

  it('removes stale entries and keeps the failing and flaky ones', () => {
    const statuses = new Map([[A, 'expected'], [B, 'unexpected'], [C, 'flaky']]);
    expect(pruneLedger({ statuses, ledger: [A, B, C], guard })).toEqual([B, C]);
  });

  it('never adds an un-ledgered failure', () => {
    const statuses = new Map([[A, 'unexpected'], [B, 'unexpected']]);
    expect(pruneLedger({ statuses, ledger: [A], guard })).toEqual([A]);
  });

  it('refuses on a run that is not authoritative', () => {
    expect(() => pruneLedger({ statuses: new Map(), ledger: [A], guard: { authoritative: false, fullRun: true } })).toThrow(
      /test:visual:docker:prune/,
    );
  });

  it('refuses on a partial run', () => {
    expect(() => pruneLedger({ statuses: new Map(), ledger: [A], guard: { authoritative: true, fullRun: false } })).toThrow(
      /partial/,
    );
  });
});

describe('ledgerGrowth', () => {
  it('lists the entries the head adds to the base', () => {
    expect(ledgerGrowth([A], [A, B, C])).toEqual([B, C]);
  });

  it('a shrink or no change adds nothing', () => {
    expect(ledgerGrowth([A, B], [A])).toEqual([]);
    expect(ledgerGrowth([A], [A])).toEqual([]);
  });

  it('a base without a ledger adds nothing (the change that creates it)', () => {
    expect(ledgerGrowth(null, [A])).toEqual([]);
  });
});
