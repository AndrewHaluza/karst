import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdapter } from './registry.js';
import { IMPLEMENTED_PROVIDERS } from './provider.js';
import { codexProjectHeader, trustKeyFor } from './workspaceTrust.js';

/**
 * The per-core translation of the launch-time trust hook (T661): claude and
 * codex write their own user config; the cores with no folder-trust prompt are
 * explicit no-ops. The adapter is the ONLY place the per-core format exists.
 */
describe('adapter workspace trust', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'karst-adapter-trust-'));
    vi.stubEnv('HOME', home);
    // The runner env (e.g. a codex sandbox) may set these; they win over HOME.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('CODEX_HOME', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('claude records hasTrustDialogAccepted in ~/.claude.json', () => {
    resolveAdapter('claude').ensureWorkspaceTrusted?.('/karst/graph-node');
    const parsed = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(parsed.projects[trustKeyFor('/karst/graph-node')]?.hasTrustDialogAccepted).toBe(true);
  });

  it('codex records trust_level = "trusted" in ~/.codex/config.toml', () => {
    resolveAdapter('codex').ensureWorkspaceTrusted?.('/karst/graph-node');
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(text).toContain(`${codexProjectHeader('/karst/graph-node')}\ntrust_level = "trusted"`);
  });

  it.each(['opencode', 'opencode2', 'antigravity'] as const)(
    '%s writes nothing (it has no folder-trust prompt)',
    (provider) => {
      resolveAdapter(provider).ensureWorkspaceTrusted?.('/karst/graph-node', { debug: () => {} });
      expect(existsSync(join(home, '.claude.json'))).toBe(false);
      expect(existsSync(join(home, '.codex'))).toBe(false);
    },
  );

  it('every implemented provider answers the hook', () => {
    for (const provider of IMPLEMENTED_PROVIDERS) {
      expect(typeof resolveAdapter(provider).ensureWorkspaceTrusted, provider).toBe('function');
    }
  });
});
