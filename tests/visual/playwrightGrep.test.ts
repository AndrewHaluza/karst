import { afterEach, describe, expect, it, vi } from 'vitest';

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
