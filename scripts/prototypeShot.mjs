#!/usr/bin/env node
// scripts/prototypeShot.mjs
// Render design prototypes per data-region from any worktree.
//
// Usage:
//   node scripts/prototypeShot.mjs <html> [--selector <css>] [--width <px>] [--out <dir>] [--regions]
//   npm run -s proto:shot -- <html> [--selector <css>] [--width <px>] [--out <dir>] [--regions]
//
// Docker is not needed. This is a view aid, not a gate.
// Uses the repo's own @playwright/test chromium, resolved relative to this script
// via createRequire(import.meta.url), so it works reliably from any worktree.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Viewport width layout tiers from src/ui/layout/layoutBreakpoints.ts.
export const DEFAULT_WIDTHS = [1280, 900, 700, 699, 480];
export const DEFAULT_HEIGHT = 900;
export const DEFAULT_OUT_DIR = path.join(os.tmpdir(), 'karst-proto');

const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  let html = null;
  let selector = null;
  const widths = [];
  let outDir = null;
  let regions = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--selector') {
      selector = argv[++i] ?? null;
    } else if (arg === '--width') {
      const val = argv[++i];
      if (val) {
        for (const part of val.split(',')) {
          const w = Number.parseInt(part.trim(), 10);
          if (!Number.isNaN(w) && w > 0) widths.push(w);
        }
      }
    } else if (arg === '--out') {
      outDir = argv[++i] ?? null;
    } else if (arg === '--regions') {
      regions = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (!arg.startsWith('-') && html === null) {
      html = arg;
    }
  }

  return {
    help: false,
    html,
    selector,
    widths: widths.length > 0 ? widths : DEFAULT_WIDTHS,
    outDir: outDir ? path.resolve(process.cwd(), outDir) : DEFAULT_OUT_DIR,
    regions,
  };
}

function cleanSelectorName(selector) {
  return selector.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'element';
}

/**
 * Render an HTML prototype and screenshot the page, selector matches, and/or regions.
 *
 * @param {object} opts
 * @param {string} opts.html - Path to the HTML file
 * @param {string} [opts.selector] - CSS selector to screenshot instead of full page
 * @param {number[]} [opts.widths] - Widths to render
 * @param {string} [opts.outDir] - Directory to write screenshots to
 * @param {boolean} [opts.regions] - Also screenshot each [data-region] element
 * @returns {Promise<string[]>} Array of written screenshot file paths
 */
export async function takePrototypeShots(opts) {
  const { html, selector = null, widths = DEFAULT_WIDTHS, outDir = DEFAULT_OUT_DIR, regions = false } = opts;

  if (!html) {
    throw new Error('missing required HTML file argument');
  }

  const absHtml = path.isAbsolute(html) ? html : path.resolve(process.cwd(), html);
  if (!existsSync(absHtml)) {
    throw new Error(`HTML file not found: ${absHtml}`);
  }

  mkdirSync(outDir, { recursive: true });

  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const written = [];

  try {
    const page = await browser.newPage();
    const fileUrl = pathToFileURL(absHtml).href;
    const baseName = path.basename(absHtml, path.extname(absHtml));

    for (const width of widths) {
      await page.setViewportSize({ width, height: DEFAULT_HEIGHT });
      await page.goto(fileUrl, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);

      if (selector) {
        const matches = page.locator(selector);
        const count = await matches.count();
        const safeSel = cleanSelectorName(selector);
        for (let i = 0; i < count; i++) {
          const loc = matches.nth(i);
          const isVisible = await loc.isVisible().catch(() => false);
          if (!isVisible) continue;
          const fileName = count === 1
            ? `${baseName}-${safeSel}-${width}.png`
            : `${baseName}-${safeSel}-${i + 1}-${width}.png`;
          const targetPath = path.join(outDir, fileName);
          await loc.screenshot({ path: targetPath });
          written.push(targetPath);
        }
      } else {
        const fullPagePath = path.join(outDir, `${baseName}-${width}.png`);
        await page.screenshot({ path: fullPagePath, fullPage: true });
        written.push(fullPagePath);
      }

      if (regions) {
        const regionLocators = page.locator('[data-region]');
        const count = await regionLocators.count();
        const seenCounts = new Map();

        for (let i = 0; i < count; i++) {
          const loc = regionLocators.nth(i);
          const isVisible = await loc.isVisible().catch(() => false);
          if (!isVisible) continue;
          const regionAttr = (await loc.getAttribute('data-region')) || `region-${i + 1}`;
          const currentCount = seenCounts.get(regionAttr) || 0;
          seenCounts.set(regionAttr, currentCount + 1);

          const disambiguation = currentCount === 0 ? '' : `-${currentCount + 1}`;
          const targetPath = path.join(outDir, `${baseName}-${regionAttr}${disambiguation}-${width}.png`);
          await loc.screenshot({ path: targetPath });
          written.push(targetPath);
        }
      }
    }
  } finally {
    await browser.close();
  }

  return written;
}

export function printHelp() {
  console.log(`Usage: proto:shot <html> [--selector <css>] [--width <px>] [--out <dir>] [--regions]

Render design prototypes per data-region from any worktree.
Docker is not needed. This is a view aid, not a gate.

Arguments:
  <html>             Path to HTML prototype file
  --selector <css>   Screenshot matches of selector instead of full page
  --width <px>       Viewport width in px (repeatable, comma-separated; default: ${DEFAULT_WIDTHS.join(', ')})
  --out <dir>        Output directory (default: OS temp dir / karst-proto)
  --regions          Also screenshot each [data-region] element separately
  -h, --help         Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.html) {
    printHelp();
    if (!args.help && !args.html) process.exitCode = 1;
    return;
  }

  try {
    const paths = await takePrototypeShots(args);
    for (const p of paths) {
      console.log(p);
    }
  } catch (error) {
    console.error(`proto:shot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
