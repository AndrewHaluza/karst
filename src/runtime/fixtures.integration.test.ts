import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimPortBand, freePortWindow, releasePortBand, removeTempDir } from './fixtures.js';

/**
 * `freePortWindow` is what keeps a leaked fixture server harmless: it must never
 * hand a suite a port that something already serves. The reported flake was a
 * leaked `0.0.0.0` listener that a `::`/`127.0.0.1` bind probe still reported
 * free, so the window included it and `startHot` refused the stranger mid-suite.
 *
 * The second failure it owns is concurrency: karst runs a suite per worktree on
 * one machine, so two runs must not both probe (and then bind) the same band.
 */
describe('freePortWindow', () => {
  let held: Server | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    if (held) await new Promise<void>((resolve) => held!.close(() => resolve()));
    held = undefined;
    for (const dir of dirs.splice(0)) removeTempDir(dir);
  });

  /** An isolated claim directory, so a real run's claims never leak into a test. */
  function lockDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'karst-port-claims-'));
    dirs.push(dir);
    return dir;
  }

  /** A claim directory a live process other than this one owns. */
  function foreignClaim(dir: string, base: number, span: number): void {
    mkdirSync(join(dir, `${base}-${span}`), { recursive: true });
    writeFileSync(join(dir, `${base}-${span}`, 'pid'), String(process.ppid));
  }

  it('never hands out a port an IPv4-wildcard listener already holds', async () => {
    held = createServer();
    await new Promise<void>((resolve) => held!.listen(0, '0.0.0.0', resolve));
    const port = (held.address() as AddressInfo).port;

    const base = await freePortWindow(1, port, port + 8, 1, lockDir());

    expect(base).toBeGreaterThan(port);
  });

  it('skips a window another live run has already claimed', async () => {
    const dir = lockDir();
    // A random base: a fixed one would collide with a concurrent run of this very
    // file in another worktree, which is the flake this claim exists to avoid.
    const base = 20_000 + Math.floor(Math.random() * 8_000);
    foreignClaim(dir, base, 4);

    const window = await freePortWindow(4, base, base + 24, 4, dir);

    expect(window).not.toBe(base);
  });

  it('releases a claimed window it found occupied, so a later run can use it', async () => {
    const dir = lockDir();
    held = createServer();
    await new Promise<void>((resolve) => held!.listen(0, '0.0.0.0', resolve));
    const port = (held.address() as AddressInfo).port;

    const base = await freePortWindow(2, port, port + 6, 2, dir);

    expect(base).toBeGreaterThan(port);
    expect(existsSync(join(dir, `${port}-2`))).toBe(false);
  });
});

describe('claimPortBand', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) removeTempDir(dir);
  });

  function lockDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'karst-port-claims-'));
    dirs.push(dir);
    return dir;
  }

  /** A pid that is certainly gone: a child that has already exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', '']);
    return child.pid ?? 0;
  }

  it('refuses a band a live process owns and accepts an unclaimed one', () => {
    const dir = lockDir();
    mkdirSync(join(dir, '24200-4'));
    writeFileSync(join(dir, '24200-4', 'pid'), String(process.ppid));

    expect(claimPortBand(24_200, 4, dir)).toBe(false);
    expect(claimPortBand(24_204, 4, dir)).toBe(true);
  });

  it('reclaims the band of a run that died, with nothing to clean up', () => {
    const dir = lockDir();
    mkdirSync(join(dir, '24210-4'));
    writeFileSync(join(dir, '24210-4', 'pid'), String(deadPid()));

    expect(claimPortBand(24_210, 4, dir)).toBe(true);
  });

  it('reclaims an ownerless claim once it is old, but not while it is fresh', () => {
    const dir = lockDir();
    mkdirSync(join(dir, '24220-4'));
    expect(claimPortBand(24_220, 4, dir)).toBe(false);

    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(dir, '24220-4'), old, old);
    expect(claimPortBand(24_220, 4, dir)).toBe(true);
  });

  it('releases only the named band', () => {
    const dir = lockDir();
    claimPortBand(24_230, 4, dir);
    releasePortBand(24_230, 4, dir);

    expect(existsSync(join(dir, '24230-4'))).toBe(false);
    expect(claimPortBand(24_230, 4, dir)).toBe(true);
  });
});
