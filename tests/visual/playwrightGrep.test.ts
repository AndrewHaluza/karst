import { afterEach, describe, expect, it, vi } from 'vitest';

const LAYOUT_PROJECTS = ['layout-setup', 'layout', 'layout-teardown'];

async function loadConfig(grep: string) {
  vi.resetModules();
  vi.stubEnv('KARST_UI_GREP', grep);
  return (await import('../../playwright.config.js')).default;
}

describe('playwright.config KARST_UI_GREP scoping', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('applies the grep to the screenshot projects', async () => {
    const config = await loadConfig('ticketForm');
    expect(String(config.grep)).toBe('/ticketForm/');
  });

  it.each(LAYOUT_PROJECTS)('never lets the grep filter %s (a scoped run must keep the ledger verdict)', async (name) => {
    const config = await loadConfig('ticketForm');
    const project = config.projects?.find((p) => p.name === name);
    expect(project, name).toBeDefined();
    expect(String(project?.grep)).toBe('/.*/');
  });
});
