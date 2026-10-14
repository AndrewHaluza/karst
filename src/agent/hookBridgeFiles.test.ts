import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_BRIDGE, MARKER_EMIT } from './hookBridge.js';
import { hookCommandDir, hookNodeCommand, writeBridgeScripts } from './hookBridgeFiles.js';
import { resolveNodeExecutable } from './nodeExecutable.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('hookCommandDir', () => {
  it('is runDir when set, configDir otherwise', () => {
    expect(hookCommandDir({ endpointUrl: 'x', configDir: '/host', runDir: '/karst-bridge/7' })).toBe('/karst-bridge/7');
    expect(hookCommandDir({ endpointUrl: 'x', configDir: '/host' })).toBe('/host');
  });
});

describe('hookNodeCommand', () => {
  it('uses the host node unless the agent sees a different filesystem', () => {
    expect(hookNodeCommand({ endpointUrl: 'x', configDir: '/h' })).toBe(resolveNodeExecutable());
    expect(hookNodeCommand({ endpointUrl: 'x', configDir: '/h', runDir: '/h' })).toBe(resolveNodeExecutable());
    expect(hookNodeCommand({ endpointUrl: 'x', configDir: '/h', runDir: '/karst-bridge/7' })).toBe('node');
  });
});

describe('writeBridgeScripts', () => {
  it('writes bridge.cjs and emit-marker.cjs, and skips identical content', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-hbf-'));
    const target = join(dir, 'claude');
    const bridgePath = writeBridgeScripts(target);
    expect(bridgePath).toBe(join(target, 'bridge.cjs'));
    expect(readFileSync(bridgePath, 'utf8')).toBe(HOOK_BRIDGE);
    expect(readFileSync(join(target, 'emit-marker.cjs'), 'utf8')).toBe(MARKER_EMIT);
    const before = statSync(bridgePath).mtimeMs;
    writeBridgeScripts(target);
    expect(statSync(bridgePath).mtimeMs).toBe(before);
  });
});
