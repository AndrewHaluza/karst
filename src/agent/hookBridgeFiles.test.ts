import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(hookNodeCommand({ endpointUrl: 'x', configDir: '/h', runDir: '/h' })).toBe('node');
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

describe('writeBridgeScripts symlink safety', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  it('replaces a planted symlink at bridge.cjs without reading or writing its target', () => {
    const root = mkdtempSync(join(tmpdir(), 'hbf-sym-')); roots.push(root);
    const dir = join(root, 'b');
    const target = join(root, 'host.txt');
    writeFileSync(target, 'host');
    writeBridgeScripts(dir);
    rmSync(join(dir, 'bridge.cjs'));
    symlinkSync(target, join(dir, 'bridge.cjs'));
    writeBridgeScripts(dir);
    expect(readFileSync(target, 'utf8')).toBe('host');
    expect(lstatSync(join(dir, 'bridge.cjs')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'bridge.cjs'), 'utf8')).toBe(HOOK_BRIDGE);
  });
  it('a symlink with identical content behind it is still replaced (never trusted)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hbf-sym-')); roots.push(root);
    const dir = join(root, 'b');
    const target = join(root, 'same.cjs');
    writeFileSync(target, HOOK_BRIDGE);
    writeBridgeScripts(dir);
    rmSync(join(dir, 'bridge.cjs'));
    symlinkSync(target, join(dir, 'bridge.cjs'));
    writeBridgeScripts(dir);
    expect(lstatSync(join(dir, 'bridge.cjs')).isSymbolicLink()).toBe(false);
  });
  it('leaves no temp files and never writes through a planted temp-path symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'hbf-sym-')); roots.push(root);
    const dir = join(root, 'b');
    const target = join(root, 'host.txt');
    writeFileSync(target, 'host');
    writeBridgeScripts(dir);
    rmSync(join(dir, 'bridge.cjs'));
    symlinkSync(target, join(dir, `bridge.cjs.${process.pid}.${Date.now()}.tmp`));
    writeBridgeScripts(dir);
    expect(readFileSync(target, 'utf8')).toBe('host');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp') && !lstatSync(join(dir, f)).isSymbolicLink())).toEqual([]);
  });
});
