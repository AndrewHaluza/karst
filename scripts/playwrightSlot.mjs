// Host-wide Playwright slot + reusable node_modules volume for dockerGate.mjs.
//
// One Playwright container at a time machine-wide (each is a Chromium plus a
// fixture server), and one `npm ci` per package-lock.json hash instead of one
// per run.

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const SLOT_FILE_NAME = 'playwright-slot.lock';
export const VOLUME_PREFIX = 'karst-pw-nm-';
export const SLOT_POLL_MS = 2_000;

/** `karst-pw-nm-<first 12 hex of the lockfile's sha256>`. */
export function nodeModulesVolumeName(lockText) {
  return `${VOLUME_PREFIX}${createHash('sha256').update(lockText).digest('hex').slice(0, 12)}`;
}

/** The anonymous `-v /work/node_modules` becomes the named volume; others pass through. */
export function withNamedNodeModules(argv, volume) {
  return argv.map((arg) => (arg === '/work/node_modules' ? `${volume}:/work/node_modules` : arg));
}

/** Volumes to remove: every karst-pw-nm volume not in `referenced`, except the newest `keep`. */
export function volumesToRemove(volumes, referenced, keep = 2) {
  const stale = volumes.filter((v) => v.name.startsWith(VOLUME_PREFIX) && !referenced.has(v.name));
  const unreferencedKept = new Set(
    volumes
      .filter((v) => v.name.startsWith(VOLUME_PREFIX))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, keep)
      .map((v) => v.name),
  );
  return stale.filter((v) => !unreferencedKept.has(v.name)).map((v) => v.name);
}

/** The slot file lives in karst global storage (the directory of the karst db), else the temp dir. */
export function slotPath(env = process.env) {
  const base = env.KARST_DB ? dirname(env.KARST_DB) : tmpdir();
  return join(base, SLOT_FILE_NAME);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readHolder(path) {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** One non-blocking attempt. Returns true when this pid now holds the slot. */
export function tryAcquire(path, pid = process.pid, alive = pidAlive) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readHolder(path);
      if (holder === pid) return true;
      if (holder !== null && alive(holder)) return false;
      try { unlinkSync(path); } catch { /* another waiter removed it first */ }
    }
  }
  return false;
}

/** Release only a slot this pid holds. */
export function release(path, pid = process.pid) {
  if (readHolder(path) !== pid) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Wait (timers only, never a busy loop) until the slot is ours.
 * `onWait` fires once when the first attempt loses; `signal` aborts the wait.
 */
export async function acquireSlot(path, { pid = process.pid, alive = pidAlive, pollMs = SLOT_POLL_MS, onWait, signal } = {}) {
  let announced = false;
  while (!tryAcquire(path, pid, alive)) {
    if (signal?.aborted) return false;
    if (!announced) { announced = true; onWait?.(); }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}
