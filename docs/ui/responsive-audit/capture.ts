/**
 * Responsive-density audit capture (T764 / UI-SPEC-RESPONSIVE-DENSITY).
 * Evidence tool only: renders every webview fixture page at AUDIT_WIDTHS, saves
 * screenshots to docs/ui/responsive-audit/<view>/<width>.png and measurements
 * to docs/ui/responsive-audit/measurements.json. Not part of any gate.
 *
 * Run (fixture server from `node tests/visual/serve.mjs` must be up on :4317):
 *   npx tsx docs/ui/responsive-audit/capture.ts [targetNameRegex]
 */
import { chromium, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsRoutes } from '../../../tests/visual/settingsRoutes.js';
import { SECTION_LABELS } from '../../../src/ui/settings/sections.js';

const AUDIT_WIDTHS = [1212, 600, 400, 320] as const;
const FLOOR_PROBE = 200;
const HEIGHT = 900;
const OUT = join(import.meta.dirname, '');
const BASE = 'http://127.0.0.1:4317';

interface Target { name: string; theme: 'dark' | 'light'; file: string; patch?: readonly [string, string]; route?: { section: keyof typeof SECTION_LABELS; hash?: string } }

const targets: Target[] = [];
for (const s of ['pending', 'running', 'passed', 'failed', 'waiting', 'exhausted']) {
  targets.push({ name: `dashboard-${s}`, theme: 'dark', file: `dashboard-${s}.html` });
}
// The fixtures seed `sandbox:null`; patch the seeded state so the sandbox strip renders (SandboxView shape).
const SANDBOX = '"sandbox":{"backend":"docker","core":"claude","workspace":"clone","network":"allowlist proxy on an internal network","actions":true,"carry":true}';
const SANDBOX_HOST = '"sandbox":{"backend":"host","core":"opencode","workspace":"worktree","network":"none (host)","actions":true,"carry":false,"note":"opencode: docker backend unsupported"}';
targets.push({ name: 'dashboard-sandbox', theme: 'dark', file: 'dashboard-running.html', patch: ['"sandbox":null', SANDBOX] });
targets.push({ name: 'dashboard-sandbox-host-note', theme: 'dark', file: 'dashboard-running.html', patch: ['"sandbox":null', SANDBOX_HOST] });
targets.push({ name: 'dashboard-running-light', theme: 'light', file: 'dashboard-running.html' });
for (const v of ['sidebar', 'usage', 'resources', 'diffs', 'ticketForm', 'gettingStarted', 'serverLogs']) {
  targets.push({ name: v, theme: 'dark', file: `${v}.html` });
}
targets.push({ name: 'sidebar-light', theme: 'light', file: 'sidebar.html' });
for (const r of settingsRoutes()) {
  const safe = r.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  targets.push({ name: `settings-${safe}`, theme: 'dark', file: 'settings-realistic.html', route: { section: r.section, ...(r.hash ? { hash: r.hash } : {}) } });
}

async function open(page: Page, t: Target): Promise<void> {
  if (t.patch) {
    const [from, to] = t.patch;
    await page.route(`**/${t.theme}/${t.file}`, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace(from, to) });
    });
  }
  await page.goto(`${BASE}/${t.theme}/${t.file}`, { waitUntil: 'load', timeout: 60_000 });
  for (let i = 0; i < 50 && (await page.locator('[data-karst-ready]').count()) === 0; i++) await page.waitForTimeout(100);
  if (t.route) {
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: SECTION_LABELS[t.route.section], exact: true }).click();
    if (t.route.hash) await page.evaluate((h) => { window.location.hash = h; }, t.route.hash);
  }
  await page.evaluate(() => new Promise<void>((d) => requestAnimationFrame(() => d())));
  await page.waitForTimeout(150);
}

/** Offenders: elements whose box extends past the viewport or whose text is clipped. */
function measure(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const root = document.scrollingElement ?? document.documentElement;
    const short = (e: Element): string => {
      const cls = Array.from(e.classList).slice(0, 3).map((c) => `.${c}`).join('');
      return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${cls}`;
    };
    const regionOf = (e: Element): string => e.closest('[data-region]')?.getAttribute('data-region') ?? '-';
    const out: { kind: string; sel: string; region: string; text: string; w: number; right: number; sw: number }[] = [];
    for (const e of Array.from(document.body.querySelectorAll('*'))) {
      if (['SCRIPT', 'STYLE'].includes(e.tagName) || (e.closest('svg') && e.tagName.toLowerCase() !== 'svg')) continue;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const text = (e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const el = e as HTMLElement;
      let kind = '';
      if (r.right > vw + 1 && cs.position !== 'fixed') kind = 'overflow-viewport';
      else if (el.scrollWidth > el.clientWidth + 1 && ['hidden', 'clip'].includes(cs.overflowX) && el.clientWidth > 0) kind = cs.textOverflow === 'ellipsis' ? 'ellipsis-clip' : 'clip';
      if (kind) out.push({ kind, sel: short(e), region: regionOf(e), text, w: Math.round(r.width), right: Math.round(r.right), sw: el.scrollWidth });
    }
    return { vw, pageScrollW: root.scrollWidth, sideways: root.scrollWidth > vw + 1, offenders: out.slice(0, 60), offenderCount: out.length,
      regions: Array.from(document.querySelectorAll('[data-region]')).map((e) => ({ region: e.getAttribute('data-region'), w: Math.round(e.getBoundingClientRect().width), sw: (e as HTMLElement).scrollWidth })) };
  });
}

const browser = await chromium.launch();
const ONLY = process.argv[2] ?? null;
const prior = existsSync(join(OUT, 'measurements.json')) ? JSON.parse(readFileSync(join(OUT, 'measurements.json'), 'utf8')) : {};
const results: Record<string, Record<string, unknown>> = ONLY ? prior : {};
for (const t of targets) {
  if (ONLY && !t.name.includes(ONLY)) continue;
  const ctx = await browser.newContext({ colorScheme: t.theme, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC' });
  const page = await ctx.newPage();
  // tsx's keepNames wraps arrows in __name(); the page has no such helper.
  await page.addInitScript('window.__name = (f) => f;');
  const dir = join(OUT, t.name);
  mkdirSync(dir, { recursive: true });
  results[t.name] = {};
  for (const w of [...AUDIT_WIDTHS, FLOOR_PROBE]) {
    await page.setViewportSize({ width: w, height: HEIGHT });
    await open(page, t);
    if (w !== FLOOR_PROBE) await page.screenshot({ path: join(dir, `${w}.png`), fullPage: true });
    results[t.name]![String(w)] = await measure(page);
  }
  await ctx.close();
  console.log('done', t.name);
}
await browser.close();
writeFileSync(join(OUT, 'measurements.json'), JSON.stringify(results, null, 1));
