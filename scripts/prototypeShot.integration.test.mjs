import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_WIDTHS, parseArgs, takePrototypeShots } from './prototypeShot.mjs';

const TEST_DIR = path.join(os.tmpdir(), `karst-proto-test-${Date.now()}`);

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Fixture</title>
  <style>
    body { margin: 0; font-family: sans-serif; background: #fff; }
    [data-region="header"] { height: 60px; background: #f0f0f0; }
    [data-region="content"] { height: 200px; background: #e0e0e0; }
    [data-region="actions"] { height: 50px; background: #d0d0d0; }
    .custom-box { width: 100px; height: 40px; background: #c0c0c0; }
  </style>
</head>
<body>
  <header data-region="header">Header Region</header>
  <main data-region="content">
    Content Region
    <div class="custom-box">Box</div>
  </main>
  <footer data-region="actions">Actions Region</footer>
</body>
</html>
`;

describe('prototypeShot', () => {
  mkdirSync(TEST_DIR, { recursive: true });
  const fixturePath = path.join(TEST_DIR, 'fixture.html');
  writeFileSync(fixturePath, FIXTURE_HTML, 'utf8');

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('DEFAULT_WIDTHS', () => {
    it('matches the layout tiers from src/ui/layout/layoutBreakpoints.ts', () => {
      const source = readFileSync(path.resolve('src/ui/layout/layoutBreakpoints.ts'), 'utf8');
      const match = source.match(/LAYOUT_WIDTHS:\s*readonly\s*number\[\]\s*=\s*\[([^\]]+)\]/);
      expect(match).toBeTruthy();
      const parsedWidths = match[1].split(',').map((s) => Number.parseInt(s.trim(), 10));
      expect(DEFAULT_WIDTHS).toEqual(parsedWidths);
    });
  });

  describe('parseArgs', () => {
    it('parses defaults', () => {
      const args = parseArgs(['foo.html']);
      expect(args.html).toBe('foo.html');
      expect(args.widths).toEqual(DEFAULT_WIDTHS);
      expect(args.regions).toBe(false);
      expect(args.selector).toBeNull();
    });

    it('parses custom options', () => {
      const args = parseArgs([
        'foo.html',
        '--selector',
        '.mock',
        '--width',
        '600,800',
        '--width',
        '1000',
        '--out',
        '/tmp/shots',
        '--regions',
      ]);
      expect(args.html).toBe('foo.html');
      expect(args.selector).toBe('.mock');
      expect(args.widths).toEqual([600, 800, 1000]);
      expect(args.outDir).toBe(path.resolve('/tmp/shots'));
      expect(args.regions).toBe(true);
    });

    it('handles --help', () => {
      expect(parseArgs(['--help']).help).toBe(true);
    });
  });

  describe('takePrototypeShots', () => {
    it('throws when html file does not exist', async () => {
      await expect(
        takePrototypeShots({ html: path.join(TEST_DIR, 'nonexistent.html') }),
      ).rejects.toThrow(/HTML file not found/);
    });

    it('screenshots full page and individual regions', async () => {
      const outDir = path.join(TEST_DIR, 'out-regions');
      const written = await takePrototypeShots({
        html: fixturePath,
        widths: [480],
        outDir,
        regions: true,
      });

      const expectedFull = path.join(outDir, 'fixture-480.png');
      const expectedHeader = path.join(outDir, 'fixture-header-480.png');
      const expectedContent = path.join(outDir, 'fixture-content-480.png');
      const expectedActions = path.join(outDir, 'fixture-actions-480.png');

      expect(written).toEqual([expectedFull, expectedHeader, expectedContent, expectedActions]);

      for (const p of written) {
        expect(existsSync(p)).toBe(true);
        expect(statSync(p).size).toBeGreaterThan(0);
      }
    });

    it('screenshots matches of --selector', async () => {
      const outDir = path.join(TEST_DIR, 'out-selector');
      const written = await takePrototypeShots({
        html: fixturePath,
        selector: '.custom-box',
        widths: [500],
        outDir,
      });

      const expected = path.join(outDir, 'fixture-custom-box-500.png');
      expect(written).toEqual([expected]);
      expect(existsSync(expected)).toBe(true);
      expect(statSync(expected).size).toBeGreaterThan(0);
    });
  });
});
