import { afterEach, describe, expect, it, vi } from 'vitest';
import { outsideGrep, SCREENSHOT_PROJECTS, testIgnoreFor } from './projectFilter.js';

const LAYOUT_PROJECTS = ['layout-setup', 'layout', 'layout-teardown'];

async function loadConfig(grep: string | undefined) {
  vi.resetModules();
  vi.stubEnv('KARST_UI_GREP', grep as string);
  return (await import('../../playwright.config.js')).default;
}

const projectGrep = (config: Awaited<ReturnType<typeof loadConfig>>, name: string) =>
  config.projects?.find((p) => p.name === name)?.grep;

describe('playwright.config KARST_UI_GREP scoping', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('applies the grep to the screenshot projects', async () => {
    const config = await loadConfig('ticketForm');
    expect(String(config.grep)).toBe('/ticketForm/');
  });

  it('applies the grep to the layout routes when the variable is set', async () => {
    const config = await loadConfig('ticketForm');
    expect(String(projectGrep(config, 'layout'))).toBe('/ticketForm/');
  });

  it.each(['layout-setup', 'layout-teardown'])('never lets a grep filter %s (a scoped run must keep the ledger verdict)', async (name) => {
    const config = await loadConfig('ticketForm');
    expect(String(projectGrep(config, name))).toBe('/.*/');
  });

  it.each(LAYOUT_PROJECTS)('keeps %s on every title when the variable is empty or unset', async (name) => {
    for (const grep of ['', undefined]) {
      const config = await loadConfig(grep);
      expect(config.grep).toBeUndefined();
      expect(String(projectGrep(config, name))).toBe('/.*/');
    }
  });
});

describe('playwright.config project filters (tests/visual/projectFilter.ts)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(SCREENSHOT_PROJECTS)('drops the tests that %s does not run before any fixture setup', async (name) => {
    const project = (await loadConfig('ticketForm')).projects?.find((p) => p.name === name);
    expect(String(project?.grepInvert)).toBe(String(outsideGrep(name)));
    expect(project?.testIgnore).toEqual(testIgnoreFor(name));
    expect(project?.grep).toBeUndefined();
  });

  it.each(LAYOUT_PROJECTS)('gives %s no theme filter', async (name) => {
    const project = (await loadConfig(undefined)).projects?.find((p) => p.name === name);
    expect(project?.grepInvert).toBeUndefined();
  });
});

describe('playwright.config CI layout merge run', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('starts no web server for the merge run: its setup and teardown open no page', async () => {
    vi.stubEnv('KARST_LAYOUT_MERGE', '1');
    expect((await loadConfig(undefined)).webServer).toBeUndefined();
  });

  it('starts the web server for every other run', async () => {
    for (const value of ['', '0']) {
      vi.stubEnv('KARST_LAYOUT_MERGE', value);
      expect((await loadConfig(undefined)).webServer).toMatchObject({ command: 'node tests/visual/serve.mjs' });
    }
  });
});
