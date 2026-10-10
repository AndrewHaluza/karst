/**
 * Project `layout-teardown`: the ledger verdict. Merges the shards the `layout`
 * tests wrote into .layout-report.json, then runs layoutLedger match / seed /
 * prune and fails on any NEW failure, STALE entry, or seed/prune refusal.
 *
 * Intent arrives as env (npm scripts, docker): KARST_LAYOUT_SEED=1,
 * KARST_LAYOUT_PRUNE=1, KARST_LAYOUT_AUTHORITATIVE=1 (only the docker script
 * sets it). See docs/ui/VISUAL-COVERAGE.md `ui:LAYOUT-SANITY`.
 */
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { LAYOUT_WIDTHS } from '../../src/ui/layout/layoutBreakpoints.js';
import type { LayoutFailure } from '../../src/ui/layout/layoutChecks.js';
import { isFullRun, matchLedger, prune, runKey, seed } from '../../src/ui/layout/layoutLedger.js';
import { readLedger, readShards, REPORT_PATH, writeLedger, type Shard } from './layoutShards.js';
import { resizeRouteId, settingsRoutes } from './settingsRoutes.js';

const RESIZE_WIDTH = 480;

function expectedRunKeys(): string[] {
  return settingsRoutes().flatMap((r) => [
    ...LAYOUT_WIDTHS.map((w) => runKey(r.id, w)),
    ...(r.section === 'agents' ? [runKey(resizeRouteId(r.id), RESIZE_WIDTH)] : []),
  ]);
}

function formatGrouped(failures: readonly LayoutFailure[]): string {
  const lines: string[] = [];
  let route = '';
  let width = -1;
  for (const f of failures) {
    if (f.route !== route) {
      route = f.route;
      width = -1;
      lines.push(`ROUTE ${route}`);
    }
    if (f.width !== width) {
      width = f.width;
      lines.push(`  ${width}px`);
    }
    const rects = f.rects.map((r) => `[${[r.x, r.y, r.w, r.h].map((n) => Math.round(n)).join(',')}]`).join(' ');
    lines.push(`    ${f.check}  ${f.selector}`, `      ${f.detail} ${rects}`);
  }
  return lines.join('\n');
}

function countByRoute(failures: readonly LayoutFailure[]): string {
  const counts = new Map<string, number>();
  for (const f of failures) counts.set(f.route, (counts.get(f.route) ?? 0) + 1);
  return Array.from(counts, ([route, n]) => `  ${route}: ${n}`).join('\n');
}

function verdict(shards: readonly Shard[]): string {
  const failures = shards.flatMap((s) => s.failures);
  const ran = new Set(shards.map((s) => runKey(s.route, s.width)));
  const guard = {
    authoritative: process.env['KARST_LAYOUT_AUTHORITATIVE'] === '1',
    fullRun: isFullRun(ran, expectedRunKeys()),
  };
  const existing = readLedger();

  if (process.env['KARST_LAYOUT_SEED'] === '1') {
    const keys = seed(failures, existing, guard);
    writeLedger(keys);
    console.log(`layout ledger seeded with ${keys.length} entries:\n${countByRoute(failures)}`);
    return '';
  }

  const ledger = existing ?? [];
  let match = matchLedger(failures, ledger, ran);
  if (process.env['KARST_LAYOUT_PRUNE'] === '1') {
    const kept = prune(failures, ledger, ran, guard);
    writeLedger(kept);
    console.log(`layout ledger pruned: ${ledger.length - kept.length} stale entr(ies) removed`);
    match = matchLedger(failures, kept, ran);
  }
  return [
    existing === null ? 'tests/visual/layout-known-failures.json is missing (seed it once: npm run test:layout:docker:seed)' : '',
    match.unexpected.length > 0 ? `${match.unexpected.length} NEW layout failure(s):\n${formatGrouped(match.unexpected)}` : '',
    match.stale.length > 0
      ? `${match.stale.length} STALE ledger entr(ies) no longer reproduce — run npm run test:layout:docker:prune:\n${match.stale.map((k) => `  ${k}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
}

test('layout ledger verdict', () => {
  const shards = readShards();
  expect(shards.length, 'no layout shards were written; did the layout project run?').toBeGreaterThan(0);

  const unchecked = Array.from(new Set(shards.filter((s) => s.unchecked).map((s) => s.route)));
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify({ failures: shards.flatMap((s) => s.failures), unchecked }, null, 2)}\n`,
  );
  if (unchecked.length > 0) {
    console.log(`region-order: ${unchecked.length} route(s) UNCHECKED (no expectations file), not passed`);
  }

  let message: string;
  try {
    message = verdict(shards);
  } catch (err) {
    message = (err as Error).message;
  }
  if (message) console.log(message);
  expect(message, 'layout-sanity failures (full list: tests/visual/.layout-report.json)').toBe('');
});
