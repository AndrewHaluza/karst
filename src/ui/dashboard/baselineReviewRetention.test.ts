import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeBaselineReviewDir,
  sweepBaselineReviewCache,
  type BaselineReviewCacheState,
} from './baselineReviewRetention.js';

/**
 * The folder under `<globalStorage>/baseline-review/<ticketId>` is a CACHE
 * (@arch:BASELINE-REVIEW): a parked ticket's overlay is re-materialized on every
 * render, so a folder of a ticket that is over is removable without losing
 * evidence.
 */
describe('baseline-review cache retention', () => {
  let storage: string;
  let root: string;

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'karst-br-cache-'));
    root = join(storage, 'baseline-review');
  });
  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  const put = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cafe.png'), 'bytes');
    return dir;
  };

  const deps = (
    states: Record<number, BaselineReviewCacheState>,
    overrides: { debug?: (m: string) => void } = {},
  ): { ticketState: (id: number) => BaselineReviewCacheState; debug: (m: string) => void } => ({
    ticketState: (id) => states[id] ?? 'missing',
    debug: overrides.debug ?? (() => {}),
  });

  describe('removeBaselineReviewDir', () => {
    it('removes one ticket folder and leaves its neighbours', () => {
      const one = put('7');
      const other = put('8');
      removeBaselineReviewDir(storage, 7);
      expect(existsSync(one)).toBe(false);
      expect(existsSync(other)).toBe(true);
    });

    it('is a no-op when the folder is already gone', () => {
      expect(() => removeBaselineReviewDir(storage, 11)).not.toThrow();
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses the non-ticket id %s and removes nothing',
      (id) => {
        const kept = put('7');
        expect(() => removeBaselineReviewDir(storage, id)).toThrow(/non-ticket id/);
        expect(existsSync(kept)).toBe(true);
      },
    );
  });

  describe('sweepBaselineReviewCache', () => {
    it('returns [] when the cache root does not exist', () => {
      expect(sweepBaselineReviewCache(storage, deps({}))).toEqual([]);
    });

    it('removes the folder of an archived ticket', () => {
      const dir = put('3');
      const removed = sweepBaselineReviewCache(storage, deps({ 3: 'archived' }));
      expect(removed).toEqual([3]);
      expect(existsSync(dir)).toBe(false);
    });

    it('removes the folder of a ticket that no longer exists', () => {
      const dir = put('4');
      expect(sweepBaselineReviewCache(storage, deps({}))).toEqual([4]);
      expect(existsSync(dir)).toBe(false);
    });

    it('keeps the folder of a ticket parked at uat (baseline review) and of a done one not yet archived', () => {
      const uat = put('5');
      const done = put('6');
      const removed = sweepBaselineReviewCache(
        storage,
        deps({ 5: 'active', 6: 'active' }),
      );
      expect(removed).toEqual([]);
      expect([existsSync(uat), existsSync(done)]).toEqual([true, true]);
    });

    it('never touches a non-numeric entry, a zero-prefixed one, or a plain file', () => {
      put('abc');
      put('0');
      put('12x');
      writeFileSync(join(root, '13'), 'not a folder');
      expect(sweepBaselineReviewCache(storage, deps({}))).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(['0', '12x', '13', 'abc']);
    });

    it('logs a per-folder failure through debug and keeps sweeping the rest', () => {
      const broken = put('2');
      const archived = put('7');
      const messages: string[] = [];
      const removed = sweepBaselineReviewCache(storage, {
        ticketState: (id) => {
          if (id === 2) throw new Error('db is gone');
          return id === 7 ? 'archived' : 'active';
        },
        debug: (m) => messages.push(m),
      });
      expect(removed).toEqual([7]);
      expect([existsSync(broken), existsSync(archived)]).toEqual([true, false]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('2');
      expect(messages[0]).toContain('db is gone');
    });

    it('reports a thrown non-Error too, rather than swallowing it silently', () => {
      put('9');
      const messages: string[] = [];
      const removed = sweepBaselineReviewCache(storage, {
        ticketState: () => {
          throw 'store closed';
        },
        debug: (m) => messages.push(m),
      });
      expect(removed).toEqual([]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('store closed');
    });
  });
});
