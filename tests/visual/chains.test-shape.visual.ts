import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHAINS } from './chains.js';
import type { ViewId } from './chains.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const EXPECTED_VIEWS: readonly ViewId[] = [
  'dashboard',
  'diffs',
  'gettingStarted',
  'resources',
  'settings',
  'sidebar',
  'ticketForm',
  'usage',
];

/**
 * Injection markers that must all be replaced by the chain.
 * If any survive, the chain is incomplete.
 */
const MARKERS = [
  '/*KARST_DS_CSS*/',
  '/*KARST_DS_JS*/',
  '/*KARST_PALETTE*/',
  '<!--KARST_CSP-->',
] as const;

test.describe('visual sweep chain table shape', () => {
  test('has exactly the eight expected view ids', () => {
    const ids = Object.keys(CHAINS).sort();
    expect(ids).toEqual([...EXPECTED_VIEWS].sort());
  });

  for (const viewId of EXPECTED_VIEWS) {
    test(`${viewId}: htmlPath resolves to an existing file`, () => {
      const entry = CHAINS[viewId]!;
      expect(entry.htmlPath).toContain(`src/ui/${viewId}/webview.html`);
      const stat = readFileSync(entry.htmlPath, 'utf8');
      expect(stat.length).toBeGreaterThan(0);
    });

    test(`${viewId}: chain replaces all injection markers`, () => {
      const raw = readFileSync(CHAINS[viewId]!.htmlPath, 'utf8');
      const hydrated = CHAINS[viewId]!.render(raw);
      for (const marker of MARKERS) {
        expect(hydrated).not.toContain(marker);
      }
    });
  }
});

test.describe('visual sweep chain module graph', () => {
  test('contains no better-sqlite3 import', () => {
    const chainsSource = readFileSync(
      join(HERE, 'chains.ts'),
      'utf8',
    );
    expect(chainsSource).not.toContain('better-sqlite3');

    const modelDir = join(HERE, '..', '..', 'src', 'model');
    const modelFiles = [
      'designSystem.ts',
      'palette.ts',
      'agentIdentity.ts',
      'providerIdentity.ts',
      'agentPicker.ts',
      'csp.ts',
    ];
    for (const file of modelFiles) {
      const src = readFileSync(join(modelDir, file), 'utf8');
      expect(src).not.toContain('better-sqlite3');
    }
  });
});
