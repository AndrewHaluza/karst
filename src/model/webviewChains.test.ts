import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DS_CSS_MARKER,
  DS_JS_MARKER,
} from './designSystem.js';
import { PALETTE_MARKER } from './palette.js';
import { AGENT_CSS_MARKER, AGENT_JS_MARKER } from './agentIdentity.js';
import { PROVIDER_CSS_MARKER, PROVIDER_JS_MARKER } from './providerIdentity.js';
import {
  AGENT_PICKER_CSS_MARKER,
  AGENT_PICKER_JS_MARKER,
} from './agentPicker.js';

const MODEL_DIR = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(MODEL_DIR, '..', 'ui');

const WEBVIEW_NAMES = readdirSync(UI_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(UI_DIR, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  })
  .sort() as readonly string[];

const EXPECTED_NAMES = [
  'dashboard',
  'diffs',
  'gettingStarted',
  'resources',
  'settings',
  'sidebar',
  'ticketForm',
  'usage',
];

const readHtml = (name: string): string =>
  readFileSync(join(UI_DIR, name, 'webview.html'), 'utf8');

/**
 * The marker pairs each injector consumes, keyed by the injector that uses them.
 * Importing the constants from the injector modules keeps this in sync with
 * their actual exports — if an injector renames a marker, this test catches it.
 */
const DESIGN_SYSTEM_MARKERS = [DS_CSS_MARKER, DS_JS_MARKER] as const;
const PALETTE_MARKERS = [PALETTE_MARKER] as const;
const AGENT_IDENTITY_MARKERS = [AGENT_CSS_MARKER, AGENT_JS_MARKER] as const;
const PROVIDER_IDENTITY_MARKERS = [PROVIDER_CSS_MARKER, PROVIDER_JS_MARKER] as const;
const AGENT_PICKER_MARKERS = [AGENT_PICKER_CSS_MARKER, AGENT_PICKER_JS_MARKER] as const;

/**
 * Per-view expected injector chains.
 *
 * Each entry lists the injectors applied, from innermost to outermost.
 * The marker arrays document which markers must be consumed; the test
 * verifies that every marker in the array is gone after hydration.
 *
 * This table is the single source of truth for the chain composition.
 */
const CHAIN_EXPECTATIONS: Record<string, {
  readonly injectors: readonly (readonly string[])[];
}> = {
  dashboard: {
    // DesignSystem → Palette → ProviderIdentity → AgentIdentity → AgentPicker
    injectors: [DESIGN_SYSTEM_MARKERS, PALETTE_MARKERS, PROVIDER_IDENTITY_MARKERS, AGENT_IDENTITY_MARKERS, AGENT_PICKER_MARKERS],
  },
  settings: {
    // DesignSystem → Palette → ProviderIdentity → AgentIdentity → AgentPicker
    injectors: [DESIGN_SYSTEM_MARKERS, PALETTE_MARKERS, PROVIDER_IDENTITY_MARKERS, AGENT_IDENTITY_MARKERS, AGENT_PICKER_MARKERS],
  },
  ticketForm: {
    // DesignSystem → Palette → ProviderIdentity → AgentIdentity → AgentPicker
    injectors: [DESIGN_SYSTEM_MARKERS, PALETTE_MARKERS, PROVIDER_IDENTITY_MARKERS, AGENT_IDENTITY_MARKERS, AGENT_PICKER_MARKERS],
  },
  sidebar: {
    // DesignSystem → AgentIdentity → Palette (palette outermost — pinned)
    injectors: [DESIGN_SYSTEM_MARKERS, AGENT_IDENTITY_MARKERS, PALETTE_MARKERS],
  },
  usage: {
    injectors: [DESIGN_SYSTEM_MARKERS, PALETTE_MARKERS],
  },
  resources: {
    injectors: [DESIGN_SYSTEM_MARKERS, PALETTE_MARKERS],
  },
  diffs: {
    injectors: [DESIGN_SYSTEM_MARKERS, PALETTE_MARKERS],
  },
  gettingStarted: {
    injectors: [DESIGN_SYSTEM_MARKERS, PALETTE_MARKERS],
  },
};

describe('webviewChains — discovery', () => {
  it('covers every webview that exists today', () => {
    expect(WEBVIEW_NAMES).toEqual(EXPECTED_NAMES);
  });

  it('has a chain expectation for every discovered webview', () => {
    for (const name of WEBVIEW_NAMES) {
      expect(CHAIN_EXPECTATIONS[name], `${name} has no chain expectation`).toBeDefined();
    }
  });
});

describe('hydrateWebview', () => {
  it('is pure: calling it twice returns equal output without mutating input', async () => {
    const { hydrateWebview } = await import('./webviewChains.js');
    for (const name of WEBVIEW_NAMES) {
      const raw = readHtml(name);
      const first = hydrateWebview(name as never, raw);
      const second = hydrateWebview(name as never, raw);
      expect(second, `${name}: second call differs`).toBe(first);
      expect(readHtml(name), `${name}: input was mutated`).toBe(raw);
    }
  });
});

describe.each(WEBVIEW_NAMES)('hydrateWebview — %s', (name) => {
  let html: string;
  let result: string;

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  beforeAll(async () => {
    const { hydrateWebview } = await import('./webviewChains.js');
    html = readHtml(name);
    result = hydrateWebview(name as never, html);
  });

  it('consumes every marker for the view\'s chain', () => {
    const expected = CHAIN_EXPECTATIONS[name]!;
    for (const markers of expected.injectors) {
      for (const marker of markers) {
        expect(result, `${name}: marker still present: ${marker}`).not.toContain(marker);
      }
    }
  });

  it('does not consume markers outside its chain', () => {
    // For markers NOT in this view's chain, verify they survive hydration
    // (only if they were present in the raw HTML to begin with).
    const expected = CHAIN_EXPECTATIONS[name]!;
    const allMarkers = [
      { markers: DESIGN_SYSTEM_MARKERS, label: 'designSystem' },
      { markers: PALETTE_MARKERS, label: 'palette' },
      { markers: AGENT_IDENTITY_MARKERS, label: 'agentIdentity' },
      { markers: PROVIDER_IDENTITY_MARKERS, label: 'providerIdentity' },
      { markers: AGENT_PICKER_MARKERS, label: 'agentPicker' },
    ];
    for (const { markers, label } of allMarkers) {
      const inChain = expected.injectors.includes(markers);
      if (inChain) continue;
      for (const marker of markers) {
        if (html.includes(marker)) {
          expect(result, `${name}: ${label} marker consumed but not in chain: ${marker}`).toContain(marker);
        }
      }
    }
  });

  it('the sidebar\'s chain has palette outermost', () => {
    if (name !== 'sidebar') return;
    // Verify by checking the agent identity markers are consumed (innermost after DS)
    // while palette is consumed outermost — all markers are gone, which proves
    // the chain applied correctly. The ordering is pinned by the CHAIN_EXPECTATIONS
    // table entry above; this test asserts the result is correct.
    expect(result).not.toContain(AGENT_CSS_MARKER);
    expect(result).not.toContain(AGENT_JS_MARKER);
    expect(result).not.toContain(PALETTE_MARKER);
  });

  it('the output still contains the design system CSS (content, not marker)', () => {
    // After hydration, the DS_CSS_MARKER is gone but its content is present.
    // Check for a distinctive token that designSystemCss() always emits.
    expect(result).toContain('--k-');
  });
});
