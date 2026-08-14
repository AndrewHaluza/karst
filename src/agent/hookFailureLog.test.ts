import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BRIDGE_PROVIDERS,
  currentEndpointPath,
  hookFailureLogPath,
  readCurrentEndpoint,
  writeCurrentEndpoint,
} from './hookFailureLog.js';

function configDir(): string {
  return mkdtempSync(join(tmpdir(), 'karst-hookfailurelog-'));
}

describe('hook channel paths', () => {
  it('keeps codex as the default so existing readers and bridges are unchanged', () => {
    const dir = '/cfg';
    expect(hookFailureLogPath(dir)).toBe(join(dir, 'codex', 'hook-failures.jsonl'));
    expect(currentEndpointPath(dir)).toBe(join(dir, 'codex', 'current-endpoint'));
  });

  it('keeps the codex bridge’s dirname(dirname()) recovery of configDir valid per provider', () => {
    // The bridge script recovers configDir by walking two directories up from
    // its diagnostics path argument; a provider segment must not change that.
    for (const provider of BRIDGE_PROVIDERS) {
      expect(dirname(dirname(hookFailureLogPath('/cfg', provider)))).toBe('/cfg');
    }
  });

  it('writes the current endpoint for EVERY bridge provider, not just codex', () => {
    // A reload rebinds the port for every live session at once. Writing only
    // codex's file is what left a revived opencode session posting into a dead
    // port (869ej1zpv G3).
    const dir = configDir();
    writeCurrentEndpoint(dir, 'http://127.0.0.1:5051/hooks');
    for (const provider of BRIDGE_PROVIDERS) {
      const target = currentEndpointPath(dir, provider);
      expect(existsSync(target), `${provider} endpoint file`).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('http://127.0.0.1:5051/hooks');
      expect(readCurrentEndpoint(dir, provider)).toBe('http://127.0.0.1:5051/hooks');
    }
  });

  it('reports no endpoint when the file was never written', () => {
    expect(readCurrentEndpoint(configDir(), 'opencode')).toBeUndefined();
  });
});
