// Shared by start.mjs and stop.mjs: the sandbox name guard and the sbx runner.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NAME_PREFIX = 'karst-uat-';
const MAX_NAME_LENGTH = 63;

/** `karst-uat-t<KARST_TICKET_ID>`, lower-cased to `[a-z0-9-]`. Throws for a name sbx may not own. */
export function scratchName(env) {
  const id = env.KARST_TICKET_ID;
  if (typeof id !== 'string' || id === '') throw new Error('KARST_TICKET_ID is not set');
  const name = `${NAME_PREFIX}t${id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, MAX_NAME_LENGTH);
  assertScratchName(name);
  return name;
}

/** Both scripts refuse a name outside the harness prefix: `sbx rm` must never reach a real ticket sandbox. */
export function assertScratchName(name) {
  if (!name.startsWith(NAME_PREFIX) || name.length === NAME_PREFIX.length) {
    throw new Error(`refusing sandbox name "${name}": it must start with ${NAME_PREFIX}`);
  }
}

export function sbx(args, timeoutMs = 120_000) {
  const out = spawnSync('sbx', args, { encoding: 'utf8', timeout: timeoutMs });
  return { code: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? out.error?.message ?? '' };
}

/** True when `sbx ls` shows the exact name as a whole word. */
export function listed(name) {
  const out = sbx(['ls']);
  return out.code === 0 && out.stdout.split('\n').some((l) => l.trim().split(/\s+/)[0] === name);
}

/** `sbx rm` the sandbox; a sandbox that is already gone is success. */
export function removeIfPresent(name) {
  assertScratchName(name);
  if (!listed(name)) return { ok: true };
  const rm = sbx(['rm', '--force', name]);
  if (rm.code !== 0 && listed(name)) return { ok: false, reason: rm.stderr.trim() };
  return { ok: true };
}

/** The empty workspace folder of one scratch sandbox: fixed per name, so a rerun reuses it and stop removes it. */
export const scratchFolder = (name) => join(tmpdir(), name);
