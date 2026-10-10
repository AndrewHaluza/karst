/**
 * Layout-sanity gate: opens EVERY settings route with the realistic state at
 * three widths and fails on broken geometry (checks a–f, layoutChecks.ts). No
 * screenshots, no baselines — a buggy page cannot be re-recorded into "correct".
 *
 * Failures are written to tests/visual/.layout-report.json and printed grouped
 * (route → width → check → selector) BEFORE the test fails, so the UAT gate
 * output is actionable without opening a file. The only exemption is the
 * ratchet ledger layout-known-failures.json: unknown failures fail, and ledger
 * entries that no longer reproduce fail too, so the ledger can only shrink.
 *
 * Geometry is theme-independent, so only the `dark` project runs it.
 * `npm run test:layout` sets KARST_LAYOUT_GATE=1; the regular visual sweep skips
 * this file so layout drift is gated once, not twice.
 * `LAYOUT_SEED_LEDGER=1` rewrites the ledger from the current failures (used
 * once, on develop; never to make a branch green).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import { applyLedger, failureKey, runChecks, type LayoutFailure } from './layoutChecks.js';
import { collectSnapshot } from './layoutSnapshot.js';
import { settingsRoutes } from './settingsRoutes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(HERE, 'layout-known-failures.json');
const REPORT_PATH = join(HERE, '.layout-report.json');
const WIDTHS = [1280, 800, 600] as const;
const HEIGHT = 900;

function readLedger(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every((k) => typeof k === 'string')) {
      throw new Error('expected a JSON array of failure keys');
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`layout-known-failures.json is unreadable: ${(err as Error).message}`);
  }
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

test('layout sanity: every settings route at 1280/800/600', async ({ gotoView, page }, testInfo) => {
  test.skip(process.env['KARST_LAYOUT_GATE'] !== '1', 'runs only via `npm run test:layout` (its own UAT gate)');
  test.skip(testInfo.project.name !== 'dark', 'geometry is theme-independent; dark project only');
  test.setTimeout(600_000);

  const failures: LayoutFailure[] = [];
  for (const route of settingsRoutes()) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await gotoView('settings', {
        scenario: 'realistic',
        route: { section: route.section, ...(route.hash === undefined ? {} : { hash: route.hash }) },
      });
      const snapshot = await collectSnapshot(page);
      failures.push(...runChecks(snapshot).map((f) => ({ ...f, route: route.id, width })));
    }
  }

  writeFileSync(REPORT_PATH, `${JSON.stringify(failures, null, 2)}\n`);
  if (process.env['LAYOUT_SEED_LEDGER'] === '1') {
    writeFileSync(LEDGER_PATH, `${JSON.stringify(failures.map(failureKey).sort(), null, 2)}\n`);
    console.log(`layout ledger seeded with ${failures.length} entries`);
    return;
  }

  const { unexpected, stale } = applyLedger(failures, readLedger());
  const message = [
    unexpected.length > 0 ? `${unexpected.length} NEW layout failure(s):\n${formatGrouped(unexpected)}` : '',
    stale.length > 0
      ? `${stale.length} STALE ledger entr(ies) no longer reproduce — delete from tests/visual/layout-known-failures.json:\n${stale.map((k) => `  ${k}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
  if (message) console.log(message);
  expect(message, 'layout-sanity failures (full list: tests/visual/.layout-report.json)').toBe('');
});
